import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { StoreWriterQueue } from "../shared/store-writer-queue.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { openOpenClawAgentSqliteWorkerStore } from "./openclaw-agent-worker-store.js";

const boundary = vi.hoisted(() => ({
  ready: Promise.resolve(),
  current: vi.fn(),
  captureState: vi.fn(() => ({ identity: { key: "synthetic-state" }, assertCurrent() {} })),
  claim: vi.fn((_options: OpenClawAgentDatabaseOptions) => "synthetic-lease"),
  release: vi.fn((_lease: string, _options: { env?: NodeJS.ProcessEnv }) => {}),
  close: vi.fn(async () => {}),
  open: vi.fn(async (_options: { databasePath: string }) => ({
    execute: async () => undefined,
    close: boundary.close,
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
vi.mock("../infra/sqlite-worker-store.js", () => ({ openSqliteWorkerStore: boundary.open }));
vi.mock("./openclaw-agent-db-identity.js", () => ({
  readOpenClawAgentDatabaseIdentity: () => ({ identity: "synthetic-file" }),
  isOpenClawAgentDatabasePathCurrent: () => true,
}));
vi.mock("./openclaw-agent-db-lease.js", () => ({
  claimOpenClawAgentDatabaseLease: boundary.claim,
  releaseOpenClawAgentDatabaseLease: boundary.release,
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
  vi.clearAllMocks();
});

it.each([
  { platform: "win32", key: "OpenClaw_State_Dir", input: "plain" },
  { platform: "win32", key: "OpenClaw_State_Dir", input: "precloned" },
  { platform: "linux", key: "OPENCLAW_STATE_DIR", input: "plain" },
] as const)(
  "pins $input environment through worker opening and cleanup on $platform",
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
      const opening = openOpenClawAgentSqliteWorkerStore(options, db, {
        moduleUrl: new URL("file:///synthetic/worker.js"),
        input: undefined,
      });
      try {
        expect(boundary.captureState).toHaveBeenCalledWith(`${root}/state.sqlite`);
        expect(boundary.claim.mock.calls[0]?.[0].env?.OPENCLAW_STATE_DIR).toBe(root);
        expect(boundary.open).not.toHaveBeenCalled();
        env[fixture.key] = "/synthetic/changed";
        options.env = { OPENCLAW_STATE_DIR: "/synthetic/replaced" };
        ready.resolve();
        const worker = await opening;
        expect(boundary.open.mock.calls[0]?.[0].databasePath).toBe(`${root}/main.sqlite`);
        await worker.close();
        expect(boundary.release.mock.calls[0]?.[1].env?.OPENCLAW_STATE_DIR).toBe(root);
        expect(boundary.close).toHaveBeenCalledOnce();
      } finally {
        ready.resolve();
        await (await opening).close();
      }
    });
  },
);
