import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../plugin-sdk/plugin-state-runtime.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { recordAgentDatabaseAdmissions } from "./agent-database-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  runOpenClawAgentWriteAdmission,
  SQLITE_SESSION_WRITER_QUEUES,
} from "./openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";

const { configureMemoryCoreDreamingState, getMemorySearchManager, memoryRuntime } =
  await vi.importActual<{
    configureMemoryCoreDreamingState: (
      open: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
    ) => void;
    getMemorySearchManager: MemoryPluginRuntime["getMemorySearchManager"];
    memoryRuntime: MemoryPluginRuntime;
  }>("../../extensions/memory-core/runtime-api.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("memory manager state owner capture", () => {
  let root: string;
  let workspace: string;
  let config: OpenClawConfig;
  let originalEnv: NodeJS.ProcessEnv;
  let otherEnv: NodeJS.ProcessEnv;
  let cwd: MockInstance<() => string>;

  beforeEach(async () => {
    root = await fs.realpath(tempDirs.make("openclaw-memory-write-owner-"));
    workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "MEMORY.md"), "Original memory.");
    originalEnv = { OPENCLAW_STATE_DIR: path.join(root, "state") };
    otherEnv = { OPENCLAW_STATE_DIR: path.join(root, "other", "state") };
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env: originalEnv }),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", originalEnv.OPENCLAW_STATE_DIR);
    config = {
      plugins: { enabled: false },
      agents: { defaults: { workspace }, list: [{ id: "main" }] },
      memory: { search: { provider: "none", store: { vector: { enabled: false } } } },
    };
    openOpenClawAgentDatabase({ agentId: "main", env: originalEnv });
    // Warm the supported runtime entry before the test controls queue admission.
    const warm = await getMemorySearchManager({ cfg: config, agentId: "main", purpose: "status" });
    expect(warm.manager).not.toBeNull();
    await warm.manager?.close?.();
    vi.stubEnv("OPENCLAW_STATE_DIR", "state");
    cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  });

  afterEach(async () => {
    recordAgentDatabaseAdmissions([], { env: originalEnv });
    recordAgentDatabaseAdmissions([], { env: otherEnv });
    await memoryRuntime.closeAllMemorySearchManagers?.();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    configureMemoryCoreDreamingState(() => {
      throw new Error("memory test state is closed");
    });
  });

  function refuse(env: NodeJS.ProcessEnv) {
    recordAgentDatabaseAdmissions(
      [
        {
          agentId: "main",
          paths: [],
          embeddedOwnerId: "other",
          code: "agent-database-ownership-mismatch",
          reason: "fixture state owner refuses this agent",
          repairHint: "fixture refusal",
        },
      ],
      { env },
    );
  }

  it("keeps creation on its admitted state owner after cwd changes", async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env: originalEnv });
    refuse(otherEnv);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const blocker = runOpenClawAgentWriteAdmission(
      { agentId: "main", path: database.path, env: originalEnv },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    const creating = getMemorySearchManager({ cfg: config, agentId: "main", purpose: "cli" });
    try {
      await vi.waitFor(() => {
        expect(SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.pending.length).toBeGreaterThan(0);
      });
      cwd.mockReturnValue(path.join(root, "other"));
      release.resolve();
      const result = await creating;
      expect(result.error).toBeUndefined();
      expect(result.manager).not.toBeNull();
      expect(result.manager?.status().dbPath).toBe(database.path);
      await result.manager?.close?.();
    } finally {
      release.resolve();
      await Promise.allSettled([creating, blocker]);
    }
  });

  it("keeps replacement on the state owner chosen before prior manager close", async () => {
    const acquired = await getMemorySearchManager({ cfg: config, agentId: "main" });
    const manager = acquired.manager;
    if (!manager?.close) {
      throw new Error(acquired.error ?? "Expected a closable memory manager");
    }
    const originalClose = manager.close.bind(manager);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    vi.spyOn(manager, "close").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      await originalClose();
    });
    refuse(otherEnv);
    const creating = getMemorySearchManager({
      cfg: {
        ...config,
        memory: { search: { ...config.memory?.search, query: { minScore: 0.01 } } },
      },
      agentId: "main",
    });
    try {
      await Promise.race([
        entered.promise,
        creating.then(() => {
          throw new Error("Replacement skipped its previous manager's close");
        }),
      ]);
      cwd.mockReturnValue(path.join(root, "other"));
      release.resolve();
      const result = await creating;
      expect(result.error).toBeUndefined();
      expect(result.manager).not.toBeNull();
      await result.manager?.close?.();
    } finally {
      release.resolve();
      await Promise.allSettled([creating]);
    }
  });

  it("rechecks retained writes against their original state owner after cwd changes", async () => {
    const acquired = await getMemorySearchManager({ cfg: config, agentId: "main", purpose: "cli" });
    const manager = acquired.manager;
    if (!manager?.sync) {
      throw new Error(acquired.error ?? "Expected a writable memory manager");
    }
    await manager.sync({ reason: "baseline", force: true });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: originalEnv });
    const before = database.db.prepare("SELECT text FROM memory_index_chunks").all();
    await fs.writeFile(path.join(workspace, "MEMORY.md"), "Changed after admission was revoked.");
    refuse(originalEnv);
    cwd.mockReturnValue(path.join(root, "other"));
    await expect(manager.sync({ reason: "revoked", force: true })).rejects.toThrow(
      "fixture state owner refuses this agent",
    );
    expect(database.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual(before);
  });
});
