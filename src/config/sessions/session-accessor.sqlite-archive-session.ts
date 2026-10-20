import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveStateDir } from "../paths.js";
import type {
  SqliteArchiveOperation,
  SqliteArchiveSessionRequest,
  SqliteArchiveSessionResponse,
} from "./session-accessor.sqlite-archive-types.js";

type ArchiveConnection = {
  worker: Worker;
  exited: Promise<void>;
  didExit: boolean;
  failure?: Error;
  retiring?: Promise<void>;
};

const sessions = resolveGlobalSingleton<{
  context: AsyncLocalStorage<ArchiveSession>;
  warm?: ArchiveSession;
}>(Symbol.for("openclaw.sqliteArchiveSessions"), () => ({
  context: new AsyncLocalStorage<ArchiveSession>(),
}));

/** Reuse only execution; each archive request still closes its read-only and file handles. */
export async function withSqliteTranscriptArchiveSession<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
): Promise<T> {
  const current = sessions.context.getStore();
  if (current?.matches(options)) {
    current.assertCurrent();
    return run();
  }
  const session = new ArchiveSession(options);
  try {
    const result = await sessions.context.run(session, run);
    await session.release();
    return result;
  } catch (error) {
    await session.close();
    throw error;
  }
}

type SqliteArchiveResponseByOperation = {
  materialize: Extract<SqliteArchiveSessionResponse, { type: "done" }>;
  publish: Extract<SqliteArchiveSessionResponse, { type: "published" }>;
  "read-page": Extract<SqliteArchiveSessionResponse, { type: "page-read" }>;
  "read-final": Extract<SqliteArchiveSessionResponse, { type: "final-read" }>;
};

/** Queue selection stays with the existing archive owner, including unscoped/cold requests. */
export function runScopedSqliteArchiveOperation<Request extends SqliteArchiveOperation>(
  request: Request,
  createWorker: (data: object) => Worker,
  enqueue: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<SqliteArchiveResponseByOperation[Request["operation"]]> | undefined;
export function runScopedSqliteArchiveOperation(
  request: SqliteArchiveOperation,
  createWorker: (data: object) => Worker,
  enqueue: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<SqliteArchiveSessionResponse> | undefined {
  const session = sessions.context.getStore();
  return session ? enqueue(() => session.run(request, createWorker)) : undefined;
}

class ArchiveSession {
  private readonly options: { agentId: string; path: string; env: { OPENCLAW_STATE_DIR: string } };
  private readonly state;
  private readonly unregisterAgent: () => void;
  private readonly unregisterState: () => void;
  private connection?: ArchiveConnection;
  private dispatched?: Promise<SqliteArchiveSessionResponse>;
  private revoked = false;
  private released = false;

  constructor(options: OpenClawAgentDatabaseOptions) {
    const env = { ...(options.env ?? process.env) };
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    this.options = {
      agentId: normalizeAgentId(options.agentId),
      env: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR },
      path: resolveOpenClawAgentSqlitePath({ ...options, env }),
    };
    this.state = captureOpenClawStateDatabaseReadAdmission(
      options.database?.path ?? resolveOpenClawStateSqlitePath(env),
    );
    this.unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
      agentId: this.options.agentId,
      path: this.options.path,
      revoke: () => {
        this.revoked = true;
      },
      close: () => this.close(),
    });
    try {
      this.unregisterState = registerOpenClawStateDatabaseAsyncResource({
        admission: this.state,
        close: () => this.close(),
      });
    } catch (error) {
      this.unregisterAgent();
      throw error;
    }
  }

  matches(options: OpenClawAgentDatabaseOptions): boolean {
    return (
      !this.revoked &&
      !this.released &&
      this.options.agentId === normalizeAgentId(options.agentId) &&
      this.options.path === resolveOpenClawAgentSqlitePath(options) &&
      this.state.databasePath ===
        path.resolve(options.database?.path ?? resolveOpenClawStateSqlitePath(options.env))
    );
  }

  assertCurrent(): void {
    if (this.revoked || this.released) {
      throw new Error("SQLite archive session was revoked");
    }
    this.state.assertCurrent();
  }

  async run(
    request: SqliteArchiveOperation,
    createWorker: (data: object) => Worker,
  ): Promise<SqliteArchiveSessionResponse> {
    this.assertCurrent();
    if (
      request.plans.some(
        (plan) =>
          normalizeAgentId(plan.agentId) !== this.options.agentId ||
          path.resolve(plan.databasePath) !== this.options.path,
      )
    ) {
      throw new Error("SQLite archive request changed its captured database owner");
    }
    // The FIFO leaves no native handles in the idle worker; transfer execution, not authority.
    const previous = sessions.warm;
    if (previous && previous !== this) {
      if (
        !previous.revoked &&
        previous.options.env.OPENCLAW_STATE_DIR === this.options.env.OPENCLAW_STATE_DIR &&
        !previous.connection?.retiring &&
        !previous.connection?.failure &&
        !previous.connection?.didExit
      ) {
        this.connection = previous.connection;
        previous.connection = undefined;
        sessions.warm = this;
      } else {
        await previous.retire();
      }
      if (previous.released) {
        await previous.close();
      }
    }
    this.assertCurrent();
    await this.connection?.retiring;
    this.assertCurrent();
    const connection = (this.connection ??= this.start(createWorker));
    sessions.warm = this;
    connection.worker.ref();
    const dispatched = new Promise<SqliteArchiveSessionResponse>((resolve, reject) => {
      const cleanup = () => {
        connection.worker.off("message", receive);
        connection.worker.off("exit", exit);
      };
      // The FIFO has one request in flight on this private, paired worker port.
      const receive = (response: SqliteArchiveSessionResponse) => {
        cleanup();
        resolve(response);
      };
      const exit = () => {
        cleanup();
        reject(
          connection.failure ??
            new Error("SQLite archive Worker exited before operation settlement"),
        );
      };
      connection.worker.on("message", receive);
      connection.worker.once("exit", exit);
      try {
        this.assertCurrent();
        if (connection.failure || connection.didExit) {
          throw connection.failure ?? new Error("SQLite archive Worker has exited");
        }
        connection.worker.postMessage(
          {
            ...request,
            type: "archive-operation",
          } satisfies SqliteArchiveSessionRequest,
          [],
        );
      } catch (error) {
        cleanup();
        reject(toStringifiedError(error));
      }
    });
    this.dispatched = dispatched;
    let result: SqliteArchiveSessionResponse;
    try {
      result = await dispatched;
    } catch (error) {
      await this.retire();
      throw error;
    } finally {
      if (this.dispatched === dispatched) {
        this.dispatched = undefined;
      }
    }
    // A publication error can conceal a failed native close. Exit is the fallback proof.
    if (result.type === "published" && result.results.some((entry) => entry.error !== undefined)) {
      await this.retire();
    }
    this.assertCurrent();
    return result;
  }

  private start(createWorker: (data: object) => Worker): ArchiveConnection {
    const worker = createWorker({
      type: "sqlite-transcript-archive-v2",
      operation: "archive-session",
      env: this.options.env,
    });
    const connection: ArchiveConnection = { worker, didExit: false, exited: Promise.resolve() };
    worker.on("error", (error) => {
      connection.failure ??= toStringifiedError(error);
    });
    worker.on("messageerror", (error) => {
      connection.failure ??= toStringifiedError(error);
      void worker.terminate();
    });
    connection.exited = new Promise((resolve) => {
      worker.once("exit", (code) => {
        connection.didExit = true;
        if (code !== 0) {
          connection.failure ??= new Error(`SQLite archive Worker exited with code ${code}`);
        }
        resolve();
      });
    });
    return connection;
  }

  private retire(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return Promise.resolve();
    }
    return (connection.retiring ??= (async () => {
      // Queued requests own no native work and will refuse at FIFO admission.
      await this.dispatched?.catch(() => {});
      connection.worker.ref();
      if (!connection.didExit) {
        try {
          connection.worker.postMessage({ type: "close" }, []);
        } catch {
          await connection.worker.terminate();
        }
      }
      await connection.exited;
      connection.worker.removeAllListeners();
      if (this.connection === connection) {
        this.connection = undefined;
      }
      if (sessions.warm === this) {
        sessions.warm = undefined;
      }
    })());
  }

  async release(): Promise<void> {
    this.released = true;
    // Successful replies have closed every native handle. Keep only the FIFO's idle carrier.
    const connection = this.connection;
    if (
      connection &&
      !this.revoked &&
      !connection.retiring &&
      !connection.didExit &&
      !connection.failure
    ) {
      connection.worker.unref();
      return;
    }
    await this.close();
  }

  async close(): Promise<void> {
    this.revoked = true;
    await this.retire();
    this.unregisterAgent();
    this.unregisterState();
  }
}
