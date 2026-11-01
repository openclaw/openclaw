import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { normalizeDatabasePath } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseExecutionScope } from "./openclaw-agent-execution-contract.js";
import { openOpenClawAgentSqliteWorkerStore } from "./openclaw-agent-worker-store.js";

const allow = () => {};
const workerModule = { moduleUrl: new URL("file:///synthetic/worker.js"), input: undefined };

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
    location() {
      return "/synthetic/captured/main.sqlite";
    }
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
vi.mock("../infra/sqlite-worker-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-worker-identity.js")>()),
  assertExistingDatabaseIdentity() {},
}));
vi.mock("./openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: boundary.capture,
}));
vi.mock("./openclaw-agent-db-identity.js", () => ({
  readOpenClawAgentDatabaseIdentity: () => ({
    identity: "synthetic-file",
    filename: normalizeDatabasePath("/synthetic/captured/main.sqlite"),
  }),
  isOpenClawAgentDatabasePathCurrent: () => true,
}));
// mock-isolation: Synthetic admission owns the handle; this fixture observes borrow release only.
vi.mock("./openclaw-agent-db-borrower.js", () => ({ retainAgentDatabase: () => () => {} }));
// mock-isolation: Synthetic worker resources must not register with the real database lifecycle.
vi.mock("./openclaw-agent-db-lifecycle.js", () => ({
  registerOpenClawAgentDatabaseAsyncResource: () => () => {},
}));
vi.mock("./openclaw-agent-db.js", () => ({ getOpenClawAgentDatabaseIfOpen: boundary.current }));
// mock-isolation: Capture worker admission timing without entering real writer queues.
vi.mock("./openclaw-agent-write-admission.js", () => ({
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

type Worker = Awaited<ReturnType<typeof openOpenClawAgentSqliteWorkerStore>>;
async function withPublication(
  run: (worker: Worker) => Promise<void>,
  options: OpenClawAgentDatabaseOptions = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: "/synthetic/captured" },
  },
) {
  const db = new DatabaseSync(":memory:");
  boundary.current.mockReturnValue({ db });
  const worker = await openOpenClawAgentSqliteWorkerStore(options, db, workerModule);
  try {
    await run(worker);
  } finally {
    await worker.close();
  }
}
it.each([
  ["domain close", true, false],
  ["retired executor", false, false],
  ["executor release", false, true],
  ["both cleanup steps", true, true],
  ["callback", true, true],
  ["command", true, true],
] as const)("preserves publication outcome when %s fails", async (failure, close, release) => {
  const original = new Error("Publication failed");
  const cleanupError = new Error("Domain cleanup failed");
  const releaseError = new Error("Executor release failed");
  const committed = { revision: 42 };
  const fails = failure === "callback" || failure === "command";
  boundary.execute.mockImplementation(async ({ type }) => {
    if (type === "database.domain.execute") {
      if (failure === "command") {
        throw original;
      }
      if (failure === "retired executor") {
        boundary.available.mockImplementation(() => {
          throw cleanupError;
        });
      }
    }
    if (type === "database.domain.close" && close) {
      throw cleanupError;
    }
  });
  if (release) {
    boundary.release.mockRejectedValue(releaseError);
  }
  await withPublication(async (worker) => {
    const work = worker.run(async (scope) => {
      if (failure === "callback") {
        throw original;
      }
      const command = scope.execute({ type: "append", input: { value: "committed" } });
      // A handled command failure must still fail its enclosing publication.
      if (failure === "command") {
        await command.catch(allow);
      } else {
        await command;
      }
      return committed;
    }, allow);
    if (fails) {
      const errors = (error: unknown): unknown[] =>
        error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
      await expect(work.catch(errors)).resolves.toEqual([original, cleanupError, releaseError]);
    } else {
      await expect(work).resolves.toBe(committed);
    }
    expect(boundary.release).toHaveBeenCalledOnce();
  });
});

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
      const ready = createDeferredCore();
      boundary.ready = ready.promise;
      await withPublication(async (worker) => {
        let work: Promise<string> | undefined;
        try {
          expect(boundary.captureState).toHaveBeenCalledWith(`${root}/state.sqlite`);
          work = worker.run(async (scope) => {
            await scope.execute({ type: "append", input: { value: "published" } });
            return "published";
          }, allow);
          expect(boundary.execute).not.toHaveBeenCalled();
          env[fixture.key] = "/synthetic/changed";
          options.env = { OPENCLAW_STATE_DIR: "/synthetic/replaced" };
          ready.resolve();
          await expect(work).resolves.toBe("published");
          const captured = boundary.capture.mock.calls[0]?.[0];
          const expected = { path: `${root}/main.sqlite`, env: { OPENCLAW_STATE_DIR: root } };
          expect(captured).toMatchObject(expected);
          expect(boundary.current.mock.calls.length).toBeGreaterThan(1);
          for (const [admitted] of boundary.current.mock.calls) {
            expect(admitted).toMatchObject(expected);
          }
          expect(boundary.release).toHaveBeenCalledExactlyOnceWith(captured);
        } finally {
          ready.resolve();
          await work?.catch(allow);
        }
      }, options);
    });
  },
);
