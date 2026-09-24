import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { StoreWriterQueue } from "../shared/store-writer-queue.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import type { AgentDatabaseExecutionScope } from "./openclaw-agent-execution-native.js";
import { openOpenClawAgentSqliteWorkerStore } from "./openclaw-agent-worker-store.js";

const boundary = vi.hoisted(() => ({
  ready: Promise.resolve(),
  current: vi.fn(),
  captureState: vi.fn(() => ({ identity: { key: "synthetic-state" }, assertCurrent() {} })),
  available: vi.fn(() => {}),
  execute: vi.fn(async (_command: { type: string; input: unknown }) => undefined),
  release: vi.fn(async (_options: OpenClawAgentDatabaseOptions) => {}),
  capture: vi.fn((options: OpenClawAgentDatabaseOptions) => ({
    async runExisting<T>(
      source: AgentDatabaseRequestExecutionSource,
      operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    ) {
      boundary.available();
      source.assertCurrent();
      return operation({ execute: boundary.execute });
    },
    release: () => boundary.release(options),
  })),
}));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    readonly isOpen = true;
  },
}));
vi.mock("../config/state-dir.js", () => ({
  resolveStateDir: (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/synthetic/default",
}));
vi.mock("./openclaw-agent-db.paths.js", () => ({
  resolveOpenClawAgentSqlitePath: (options: OpenClawAgentDatabaseOptions) =>
    options.path ?? `${options.env?.OPENCLAW_STATE_DIR}/${options.agentId}.sqlite`,
}));
vi.mock("./openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: (env: NodeJS.ProcessEnv) =>
    `${env.OPENCLAW_STATE_DIR}/state.sqlite`,
}));
vi.mock("../infra/sqlite-worker-identity.js", () => ({ assertExistingDatabaseIdentity() {} }));
vi.mock("./openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: boundary.capture,
}));
vi.mock("./openclaw-agent-db-identity.js", () => ({
  readOpenClawAgentDatabaseIdentity: () => ({
    identity: "synthetic-file",
    filename: "/synthetic/captured/main.sqlite",
  }),
  isOpenClawAgentDatabasePathCurrent: () => true,
}));
vi.mock("./openclaw-agent-db-lifecycle.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: () => () => {},
  retainAgentDatabase: () => () => {},
}));
vi.mock("./openclaw-agent-db.js", () => ({ getOpenClawAgentDatabaseIfOpen: boundary.current }));
vi.mock("./openclaw-agent-write-admission.js", () => ({
  SQLITE_SESSION_WRITER_QUEUES: new Map<string, StoreWriterQueue>(),
  runOpenClawAgentWorkerWrite: async (
    _options: OpenClawAgentDatabaseOptions,
    run: () => Promise<unknown>,
  ) => {
    await boundary.ready;
    return await run();
  },
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: boundary.captureState,
  registerOpenClawStateDatabaseAsyncResource: () => () => {},
}));

afterEach(() => {
  boundary.ready = Promise.resolve();
  boundary.execute.mockReset().mockResolvedValue(undefined);
  boundary.release.mockReset().mockResolvedValue(undefined);
  boundary.available.mockReset();
  vi.clearAllMocks();
});

async function openPublication() {
  const db = new DatabaseSync(":memory:");
  boundary.current.mockReturnValue({ db });
  return openOpenClawAgentSqliteWorkerStore(
    { agentId: "main", env: { OPENCLAW_STATE_DIR: "/synthetic/captured" } },
    db,
    { moduleUrl: new URL("file:///synthetic/worker.js"), input: undefined },
  );
}

it.each(["domain close", "retired executor", "executor release", "both cleanup steps"] as const)(
  "preserves completed publication when %s fails",
  async (failurePoint) => {
    const cleanupError = new Error("Publication cleanup unavailable after completed command");
    const releaseError = new Error("Executor release failed after completed publication");
    const committed = { revision: 42 };
    boundary.execute.mockImplementation(async (command) => {
      if (command.type === "database.domain.execute" && failurePoint === "retired executor") {
        boundary.available.mockImplementation(() => {
          throw cleanupError;
        });
      }
      if (
        command.type === "database.domain.close" &&
        (failurePoint === "domain close" || failurePoint === "both cleanup steps")
      ) {
        throw cleanupError;
      }
    });
    if (failurePoint === "executor release" || failurePoint === "both cleanup steps") {
      boundary.release.mockRejectedValue(releaseError);
    }
    const worker = await openPublication();
    try {
      await expect(
        worker.run(
          async (scope) => {
            await scope.execute({ type: "append", input: { value: "committed" } });
            return committed;
          },
          () => undefined,
        ),
      ).resolves.toBe(committed);
      expect(boundary.release).toHaveBeenCalledOnce();
    } finally {
      await worker.close();
    }
  },
);

it.each(["callback", "command"] as const)(
  "preserves the failed %s and both cleanup errors",
  async (failurePoint) => {
    const original = new Error("Publication failed before producing a completed result");
    const cleanupError = new Error("Domain cleanup also failed");
    const releaseError = new Error("Executor release also failed");
    boundary.execute.mockImplementation(async (command) => {
      if (command.type === "database.domain.execute" && failurePoint === "command") {
        throw original;
      }
      if (command.type === "database.domain.close") {
        throw cleanupError;
      }
    });
    boundary.release.mockRejectedValue(releaseError);
    const worker = await openPublication();
    try {
      const work = worker.run(
        async (scope) => {
          if (failurePoint === "callback") {
            throw original;
          }
          // A caller can handle its command promise, but the adapter still owns its failure.
          await scope.execute({ type: "append", input: { value: "failed" } }).catch(() => {});
          return "must not report success";
        },
        () => undefined,
      );
      const errors = (error: unknown): unknown[] =>
        error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
      const outcome = await work.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      expect(outcome.ok).toBe(false);
      if (!("error" in outcome)) {
        throw new Error("Failed publication unexpectedly succeeded");
      }
      expect(errors(outcome.error)).toEqual([original, cleanupError, releaseError]);
      expect(boundary.release).toHaveBeenCalledOnce();
    } finally {
      await worker.close();
    }
  },
);

it.each([
  { platform: "win32", key: "OpenClaw_State_Dir", input: "plain" },
  { platform: "win32", key: "OpenClaw_State_Dir", input: "precloned" },
  { platform: "linux", key: "OPENCLAW_STATE_DIR", input: "plain" },
] as const)(
  "pins $input environment through queued worker execution and cleanup on $platform",
  async (fixture) => {
    await withMockedPlatform(fixture.platform, async () => {
      const root = "/synthetic/captured";
      const rawEnv = { [fixture.key]: root };
      const env = fixture.input === "precloned" ? cloneEnvWithPlatformSemantics(rawEnv) : rawEnv;
      const options = { agentId: "main", env };
      const db = new DatabaseSync(":memory:");
      boundary.current.mockReturnValue({ db });
      const ready = createDeferredCore();
      boundary.ready = ready.promise;
      const worker = await openOpenClawAgentSqliteWorkerStore(options, db, {
        moduleUrl: new URL("file:///synthetic/worker.js"),
        input: undefined,
      });
      let work: Promise<string> | undefined;
      try {
        expect(boundary.captureState).toHaveBeenCalledWith(`${root}/state.sqlite`);
        work = worker.run(
          async (scope) => {
            await scope.execute({ type: "append", input: { value: "published" } });
            return "published";
          },
          () => undefined,
        );
        expect(boundary.capture.mock.calls[0]?.[0].env?.OPENCLAW_STATE_DIR).toBe(root);
        expect(boundary.execute).not.toHaveBeenCalled();
        env[fixture.key] = "/synthetic/changed";
        options.env = { OPENCLAW_STATE_DIR: "/synthetic/replaced" };
        ready.resolve();
        await expect(work).resolves.toBe("published");
        const captured = boundary.capture.mock.calls[0]?.[0];
        expect(captured?.path).toBe(`${root}/main.sqlite`);
        expect(captured?.env?.OPENCLAW_STATE_DIR).toBe(root);
        expect(boundary.current.mock.calls.length).toBeGreaterThan(1);
        for (const [admitted] of boundary.current.mock.calls) {
          expect(admitted.path).toBe(`${root}/main.sqlite`);
          expect(admitted.env.OPENCLAW_STATE_DIR).toBe(root);
        }
        expect(boundary.release).toHaveBeenCalledExactlyOnceWith(captured);
        expect(boundary.release.mock.calls[0]?.[0].env?.OPENCLAW_STATE_DIR).toBe(root);
        await worker.close();
      } finally {
        ready.resolve();
        await work?.catch(() => undefined);
        await worker.close();
      }
    });
  },
);
