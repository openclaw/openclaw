import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { isPromise } from "node:util/types";
import type { Result } from "@openclaw/normalization-core/result";
import type {
  BoardOp,
  BoardSnapshot,
  BoardWidgetMaterializedPutParams,
} from "../../packages/gateway-protocol/src/index.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { targetDiscoveryLane } from "../config/sessions/session-transcript-worker-resources.js";
import {
  withSessionHistoryWorkerDatabase,
  type SessionHistoryWorkerDatabase,
} from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { resolveStateDir } from "../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import {
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseRuntime,
} from "../state/openclaw-agent-db.js";
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
import {
  runOpenClawAgentBoardReadAdmission,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { BoardValidationError } from "./board-layout.js";
import { hasUnknownBoardWriteOutcome, restoreBoardError } from "./board-store-errors.js";
import type {
  BoardSessionTarget,
  BoardStore,
  BoardWriteOptions,
  BoardWidgetWriteOptions,
  BoardWidgetDocument,
  BoardSnapshotWithHtmlViewMetadata,
  BoardWidgetMcpAppDocument,
} from "./board-store.js";
import { createSessionActorBoardStore } from "./session-actor-board-store.js";
import { reportBoardCleanupFailure } from "./sqlite-board-authority.js";
import type { BoardWriteOperations, BoardWriteOutcome } from "./sqlite-board-operations.js";
import type { BoardSessionIdentity } from "./sqlite-board-store.kernel.js";
import type { BoardWorkerInput } from "./sqlite-board-store.worker.js";

type ResolvedBoardSession = {
  agentId: string;
  path?: string;
  sessionKey: string;
  /** Captured logical routing authority; worker grants must not repeat database discovery. */
  assertCurrent?: () => void;
  absent?: { assertCurrent(): void };
};

type SqliteBoardStoreOptions = {
  resolveSession: (
    target: BoardSessionTarget,
  ) => ResolvedBoardSession | Promise<ResolvedBoardSession>;
  env?: NodeJS.ProcessEnv;
};

type PreparedBoardSession = ResolvedBoardSession & { env: NodeJS.ProcessEnv };

export class SqliteBoardStore implements BoardStore {
  constructor(private readonly options: SqliteBoardStoreOptions) {}

  private async withSession<T>(
    target: BoardSessionTarget,
    memoryConsumer: (store: BoardStore) => Promise<T>,
    durableConsumer: (resolved: PreparedBoardSession) => Promise<T>,
    missing?: () => T | Promise<T>,
  ): Promise<T> {
    const env = cloneEnvWithPlatformSemantics(this.options.env ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const resolved = { ...(await this.options.resolveSession({ ...target })), env };
    const assertCurrent = () => resolved.assertCurrent?.();
    const authority = { assertCurrent, authorize: assertCurrent };
    const scope = {
      ...resolved,
      storePath: resolved.path,
      env: this.options.env ? resolved.env : undefined,
    };
    const memory = captureSessionActorStorageOwner(scope, authority);
    if (!memory) {
      return durableConsumer(resolved);
    }
    const result = await withSessionActorStorage(
      scope,
      {
        authority: memory.authority,
        lifetime: { assertCurrent, assertReadable: assertCurrent },
      },
      async (binding) => ({
        value: await memoryConsumer(createSessionActorBoardStore(() => binding)),
      }),
    );
    if (result) {
      return result.value;
    }
    assertCurrent();
    if (missing) {
      return missing();
    }
    throw new BoardValidationError("not_found", `board session not found: ${resolved.sessionKey}`);
  }

  private write<T>(
    resolved: PreparedBoardSession,
    options: BoardWriteOptions | undefined,
    worker: (
      scope: Pick<SqliteWorkerStore<BoardWriteOperations>, "execute">,
      sessionKey: string,
    ) => Promise<BoardWriteOutcome<T>>,
    prepare?: () => Promise<void>,
  ): Promise<T> {
    if (resolved.absent) {
      options?.assertCurrent?.();
      resolved.assertCurrent?.();
      resolved.absent.assertCurrent();
      throw new IncognitoSessionMissingError();
    }
    const { env } = resolved;
    const databaseOptions = {
      agentId: resolved.agentId,
      env,
      path: resolveOpenClawAgentSqlitePath({ ...resolved, env }),
    };
    const assertCurrent = () => resolved.assertCurrent?.();
    assertCurrent();
    return runOpenClawAgentWriteAdmission(
      databaseOptions,
      async (identity, assertDatabaseCurrent) => {
        const source = await withSessionHistoryWorkerDatabase(
          databaseOptions,
          (reader) =>
            reader.readExactEntries({
              env,
              sessionKeys: [resolved.sessionKey],
              projection: "exact",
              snapshotFields: [],
              expectedIdentity: identity,
            }),
          targetDiscoveryLane,
        );
        assertDatabaseCurrent();
        assertCurrent();
        const entry = source.entries[0]?.entry;
        if (!entry) {
          throw new BoardValidationError(
            "not_found",
            `board session not found: ${resolved.sessionKey}`,
          );
        }
        const expectedSession: BoardSessionIdentity = {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        };
        const assertPreparedCurrent = () => {
          assertDatabaseCurrent();
          assertCurrent();
        };
        return withOpenClawAgentDatabaseRuntime(
          databaseOptions,
          async (database) => {
            if (prepare) {
              await prepare();
            }
            assertPreparedCurrent();
            const publication = await openOpenClawAgentSqliteWorkerStore<BoardWriteOperations>(
              databaseOptions,
              database.db,
              {
                moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.boardStore),
                input: {
                  agentId: databaseOptions.agentId,
                  sessionKey: resolved.sessionKey,
                  expectedSession,
                } satisfies BoardWorkerInput,
              },
            );
            let outcome: Result<T, unknown>;
            try {
              const value = await publication.run(async (scope) => {
                // Source revocation blocks new admissions; admitted writes may finish their commit.
                options?.assertCurrent?.();
                let committed: BoardWriteOutcome<T>;
                try {
                  committed = await worker(scope, resolved.sessionKey);
                } catch (error) {
                  if (hasUnknownBoardWriteOutcome(error)) {
                    sessionChanges.emit({
                      sessionKey: resolved.sessionKey,
                      storePath: database.path,
                    });
                  }
                  throw error;
                }
                // Committed invalidation belongs to the original store, even after caller revocation.
                sessionChanges.emitBatch(committed.changes);
                return committed.value;
              }, assertPreparedCurrent);
              outcome = { ok: true, value };
            } catch (error) {
              outcome = { ok: false, error: restoreBoardError(error) };
            }
            let cleanup: Result<void, unknown>;
            try {
              await publication.close();
              cleanup = { ok: true, value: undefined };
            } catch (error) {
              cleanup = { ok: false, error };
            }
            if (!outcome.ok) {
              if (!cleanup.ok) {
                throw new AggregateError(
                  [outcome.error, cleanup.error],
                  "Board publication and cleanup failed",
                  { cause: outcome.error },
                );
              }
              throw outcome.error;
            }
            if (!cleanup.ok) {
              reportBoardCleanupFailure(cleanup.error);
            }
            return outcome.value;
          },
          () => {
            options?.assertCurrent?.();
            assertPreparedCurrent();
          },
        );
      },
      true,
    );
  }

  async getSnapshot(target: BoardSessionTarget): Promise<BoardSnapshot> {
    return this.useSnapshot(target, (snapshot) => snapshot);
  }

  async getSnapshotWithHtmlViewMetadata(
    target: BoardSessionTarget,
  ): Promise<BoardSnapshotWithHtmlViewMetadata> {
    return this.withSession<BoardSnapshotWithHtmlViewMetadata>(
      target,
      (store) => store.getSnapshotWithHtmlViewMetadata(target),
      (resolved) => this.consumeSnapshotWithHtmlViewMetadata(resolved, (snapshot) => snapshot),
      () => ({
        snapshot: { sessionKey: target.sessionKey, revision: 0, tabs: [], widgets: [] },
        htmlViewMetadata: new Map(),
      }),
    );
  }

  private async consumeRead<Value, T>(
    resolved: PreparedBoardSession,
    worker: (
      reader: SessionHistoryWorkerDatabase,
      sessionKey: string,
      env: NodeJS.ProcessEnv,
      expectedIdentity: DatabaseFileIdentity,
    ) => Promise<Value | undefined>,
    consume: (value: Value | undefined, sessionKey: string) => T,
  ): Promise<Awaited<T>> {
    if (resolved.absent) {
      resolved.assertCurrent?.();
      resolved.absent.assertCurrent();
      const result = await consume(undefined, resolved.sessionKey);
      resolved.assertCurrent?.();
      resolved.absent.assertCurrent();
      return result;
    }
    const env = captureSessionTranscriptStorageEnvironment(resolved.env);
    const captured = {
      agentId: resolved.agentId,
      sessionKey: resolved.sessionKey,
      env,
      path: resolveOpenClawAgentSqlitePath({ ...resolved, env }),
    };
    // Consumer continuations retain caller authority, not this read turn's reentrant grant.
    const runInCallerContext = AsyncLocalStorage.snapshot();
    const accept = (value: Value | undefined) => {
      resolved.assertCurrent?.();
      const result = runInCallerContext(consume, value, captured.sessionKey);
      // Cleanup may await the worker after consumption has already rejected.
      if (isPromise(result)) {
        void result.catch(() => {});
      }
      return { value: result };
    };
    const identity = readDatabasePathIdentitySync(captured.path);
    if (!identity.key.startsWith("file:")) {
      const result = await runOpenClawAgentBoardReadAdmission(captured, async () =>
        accept(undefined),
      );
      return await result.value;
    }
    // FIFO-held reads and their failure cleanup use the writer-safe discovery lane.
    const result = await withSessionHistoryWorkerDatabase(
      { ...captured, path: identity.canonicalPath, requestedPaths: [captured.path] },
      (reader) =>
        runOpenClawAgentBoardReadAdmission(captured, async () => {
          resolved.assertCurrent?.();
          const value = await worker(reader, captured.sessionKey, env, identity);
          reader.assertCurrent();
          return accept(value);
        }),
      targetDiscoveryLane,
    ).catch((error: unknown) => {
      throw restoreBoardError(error);
    });
    // External consumer work must not hold the database's FIFO lane.
    return await result.value;
  }

  async useSnapshot<T>(
    target: BoardSessionTarget,
    consume: (snapshot: BoardSnapshot) => T,
  ): Promise<Awaited<T>> {
    return await this.withSession(
      target,
      (store) => store.useSnapshot(target, consume),
      (resolved) =>
        this.consumeSnapshotWithHtmlViewMetadata(resolved, ({ snapshot }) => consume(snapshot)),
      async () => consume({ sessionKey: target.sessionKey, revision: 0, tabs: [], widgets: [] }),
    );
  }

  async useWidgetDocument<T>(
    target: BoardSessionTarget,
    name: string,
    consume: (document: BoardWidgetDocument | undefined) => T,
  ): Promise<Awaited<T>> {
    return await this.withSession(
      target,
      (store) => store.useWidgetDocument(target, name, consume),
      (resolved) => this.consumeWidgetDocument(resolved, name, consume),
      async () => consume(undefined),
    );
  }

  private consumeSnapshotWithHtmlViewMetadata<T>(
    resolved: PreparedBoardSession,
    consume: (snapshot: BoardSnapshotWithHtmlViewMetadata) => T,
  ): Promise<Awaited<T>> {
    return this.consumeRead(
      resolved,
      (reader, sessionKey, env, expectedIdentity) =>
        reader.readBoardSnapshot({ sessionKey, env, expectedIdentity }),
      (stored, sessionKey) =>
        consume(
          stored ?? {
            snapshot: { sessionKey, revision: 0, tabs: [], widgets: [] },
            htmlViewMetadata: new Map(),
          },
        ),
    );
  }

  async applyOps(
    target: BoardSessionTarget,
    ops: readonly BoardOp[],
    options?: BoardWriteOptions,
  ): Promise<BoardSnapshot> {
    if (ops.length === 0) {
      return this.getSnapshot(target);
    }
    const capturedOps = structuredClone(ops);
    return this.withSession(
      target,
      (store) => store.applyOps(target, capturedOps, options),
      (resolved) =>
        this.write(resolved, options, (scope, sessionKey) =>
          scope.execute({
            type: "boards.applyOps",
            input: { sessionKey, ops: capturedOps },
          }),
        ),
    );
  }

  async putWidget(params: BoardWidgetMaterializedPutParams, options?: BoardWidgetWriteOptions) {
    let preparedParams = structuredClone(params);
    return this.withSession(
      params,
      (store) => store.putWidget(preparedParams, options),
      (resolved) => {
        const viewGeneration = randomBytes(16).toString("hex");
        const content = preparedParams.content;
        const resolveInteraction = options?.resolveMcpAppInteraction;
        const prepare =
          content.kind === "mcp-app" && content.interactive && resolveInteraction
            ? async () => {
                if (!(await resolveInteraction())) {
                  preparedParams = {
                    ...preparedParams,
                    content: { ...content, interactive: false },
                    declared: undefined,
                  };
                }
              }
            : undefined;
        return this.write(
          resolved,
          options,
          (scope, sessionKey) =>
            scope.execute({
              type: "boards.putWidget",
              input: { sessionKey, params: preparedParams, viewGeneration },
            }),
          prepare,
        );
      },
    );
  }

  async grant(
    target: BoardSessionTarget,
    name: string,
    decision: "granted" | "rejected",
    revision: number,
    instanceId?: string,
    options?: BoardWriteOptions,
  ): Promise<BoardSnapshot> {
    return this.withSession(
      target,
      (store) => store.grant(target, name, decision, revision, instanceId, options),
      (resolved) =>
        this.write(resolved, options, (scope, sessionKey) =>
          scope.execute({
            type: "boards.grant",
            input: { sessionKey, name, decision, revision, instanceId },
          }),
        ),
    );
  }

  private consumeWidgetDocument<T>(
    resolved: PreparedBoardSession,
    name: string,
    consume: (document: BoardWidgetDocument | undefined) => T,
    contentKind?: "mcp-app",
  ): Promise<Awaited<T>> {
    return this.consumeRead(
      resolved,
      (reader, sessionKey, env, expectedIdentity) =>
        reader.readBoardWidgetDocument({ sessionKey, name, contentKind, env, expectedIdentity }),
      consume,
    );
  }

  async readWidgetMcpApp(
    target: BoardSessionTarget,
    name: string,
  ): Promise<BoardWidgetMcpAppDocument | undefined> {
    return this.withSession(
      target,
      (store) => store.readWidgetMcpApp(target, name),
      (resolved) =>
        this.consumeWidgetDocument(
          resolved,
          name,
          (document) => (document && "descriptor" in document ? document : undefined),
          "mcp-app",
        ),
      () => undefined,
    );
  }
}
