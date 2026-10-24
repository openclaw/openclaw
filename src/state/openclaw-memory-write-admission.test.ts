import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configSnapshot from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../plugin-sdk/plugin-state-runtime.js";
import * as state from "../plugin-sdk/plugin-state-test-runtime.js";
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { recordAgentDatabaseAdmissions } from "./agent-database-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import * as agentDb from "./openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES as writerQueues } from "./openclaw-agent-write-admission-state.js";
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";

const { configureMemoryCoreDreamingState, createMemoryRuntime } = await vi.importActual<{
  configureMemoryCoreDreamingState: (
    open: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
  ) => void;
  createMemoryRuntime: (host: {
    runInBackgroundContext: <T>(run: () => T) => T;
  }) => MemoryPluginRuntime;
}>("../../extensions/memory-core/runtime-api.js");

const memoryRuntime = createMemoryRuntime({ runInBackgroundContext: (run) => run() });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let workspace: string;
let config: OpenClawConfig;
let originalEnv: NodeJS.ProcessEnv;
let cwd: MockInstance<() => string>;
const refusal = "fixture state owner refuses this agent";
const refusalAdmission = {
  agentId: "main",
  paths: [],
  embeddedOwnerId: "other",
  code: "agent-database-ownership-mismatch" as const,
  reason: refusal,
  repairHint: "fixture refusal",
};
const refuse = (env: NodeJS.ProcessEnv) =>
  recordAgentDatabaseAdmissions([refusalAdmission], { env });
const acquire = async (cfg = config, purpose?: "status" | "cli") => {
  const result = await memoryRuntime.getMemorySearchManager({ cfg, agentId: "main", purpose });
  expect(result.error).toBeUndefined();
  assert(result.manager, "Expected a memory manager");
  return result.manager;
};
const openDatabase = () => agentDb.openOpenClawAgentDatabase({ agentId: "main", env: originalEnv });
const otherEnv = () => ({ OPENCLAW_STATE_DIR: path.join(root, "other", "state") });

beforeEach(async () => {
  root = await fs.realpath(tempDirs.make("openclaw-memory-write-owner-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "MEMORY.md"), "Original memory.");
  originalEnv = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    state.createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env: originalEnv }),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", originalEnv.OPENCLAW_STATE_DIR);
  config = {
    plugins: { enabled: false },
    agents: { defaults: { workspace }, entries: { main: {} } },
    memory: { search: { provider: "none", store: { vector: { enabled: false } } } },
  };
  configSnapshot.setRuntimeConfigSnapshot(config);
  openDatabase();
  // Warm the supported runtime entry before the test controls queue admission.
  await (await acquire(config, "status")).close?.();
  vi.stubEnv("OPENCLAW_STATE_DIR", "state");
  cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(async () => {
  recordAgentDatabaseAdmissions([], { env: originalEnv });
  recordAgentDatabaseAdmissions([], { env: otherEnv() });
  await memoryRuntime.closeAllMemorySearchManagers?.();
  await closeOpenClawAgentDatabasesAsync();
  agentDb.closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  state.resetPluginStateStoreForTests();
  configSnapshot.clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  configureMemoryCoreDreamingState(() => assert.fail("memory test state is closed"));
});

it.each(["creation", "replacement"] as const)(
  "keeps %s on its admitted owner after cwd changes",
  async (mode) => {
    const database = openDatabase();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const wait = () => {
      entered.resolve();
      return release.promise;
    };
    let blocker: Promise<unknown> | undefined;
    let nextConfig = config;
    refuse(otherEnv());
    if (mode === "creation") {
      blocker = runOpenClawAgentWriteAdmission(
        { agentId: "main", path: database.path, env: originalEnv },
        wait,
      );
      await entered.promise;
    } else {
      const manager = await acquire();
      assert(typeof manager.close === "function", "Expected a closable memory manager");
      const close = manager.close.bind(manager);
      vi.spyOn(manager, "close").mockImplementation(() => wait().then(close));
      nextConfig = {
        ...config,
        memory: { search: { ...config.memory?.search, query: { minScore: 0.01 } } },
      };
    }
    const creating = acquire(nextConfig, mode === "creation" ? "cli" : undefined);
    try {
      if (mode === "creation") {
        await vi.waitFor(() =>
          expect(writerQueues.get(database.path)?.pending.length).toBeGreaterThan(0),
        );
      } else {
        await Promise.race([
          entered.promise,
          creating.then(() => assert.fail("Replacement skipped its previous manager's close")),
        ]);
      }
      cwd.mockReturnValue(path.join(root, "other"));
      release.resolve();
      const manager = await creating;
      expect(manager.status().dbPath).toBe(database.path);
      await manager.close?.();
    } finally {
      release.resolve();
      await Promise.allSettled([creating, blocker]);
    }
  },
);

it("rechecks retained writes against their original state owner after cwd changes", async () => {
  const manager = await acquire(config, "cli");
  assert(typeof manager.sync === "function", "Expected a writable memory manager");
  await manager.sync({ reason: "baseline", force: true });
  const database = openDatabase();
  const before = database.db.prepare("SELECT text FROM memory_index_chunks").all();
  await fs.writeFile(path.join(workspace, "MEMORY.md"), "Changed after admission was revoked.");
  refuse(originalEnv);
  cwd.mockReturnValue(path.join(root, "other"));
  await expect(manager.sync({ reason: "revoked", force: true })).rejects.toThrow(refusal);
  expect(database.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual(before);
});
