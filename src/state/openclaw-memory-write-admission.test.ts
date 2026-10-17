import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenKeyedStoreOptions } from "../plugin-sdk/plugin-state-runtime.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { recordAgentDatabaseAdmissions } from "./agent-database-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES as writerQueues } from "./openclaw-agent-write-admission-state.js";
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";

const { configureMemoryCoreDreamingState, createMemoryRuntime } = await vi.importActual<
  typeof import("../../extensions/memory-core/runtime-api.js")
>("../../extensions/memory-core/runtime-api.js");

const memoryRuntime = createMemoryRuntime({ runInBackgroundContext: (run) => run() });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("memory manager state owner capture", () => {
  let root: string;
  let workspace: string;
  let config: OpenClawConfig;
  let originalEnv: NodeJS.ProcessEnv;
  let otherEnv: NodeJS.ProcessEnv;
  let cwd: MockInstance<() => string>;
  const acquire = (cfg = config, purpose?: "status" | "cli") =>
    memoryRuntime.getMemorySearchManager({ cfg, agentId: "main", purpose });
  const openDatabase = () => openOpenClawAgentDatabase({ agentId: "main", env: originalEnv });

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
      agents: { defaults: { workspace }, entries: { main: {} } },
      memory: { search: { provider: "none", store: { vector: { enabled: false } } } },
    };
    setRuntimeConfigSnapshot(config);
    openDatabase();
    // Warm the supported runtime entry before the test controls queue admission.
    const warm = await acquire(config, "status");
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
    clearRuntimeConfigSnapshot();
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

  it.each(["creation", "replacement"] as const)(
    "keeps %s on its admitted owner after cwd changes",
    async (mode) => {
      const database = openDatabase();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      let blocker: Promise<unknown> | undefined;
      let nextConfig = config;
      if (mode === "creation") {
        refuse(otherEnv);
        blocker = runOpenClawAgentWriteAdmission(
          { agentId: "main", path: database.path, env: originalEnv },
          wait,
        );
        await entered.promise;
      } else {
        const acquired = await acquire();
        const manager = acquired.manager;
        if (!manager?.close) {
          throw new Error(acquired.error ?? "Expected a closable memory manager");
        }
        const close = manager.close.bind(manager);
        vi.spyOn(manager, "close").mockImplementation(async () => {
          await wait();
          await close();
        });
        refuse(otherEnv);
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
            creating.then(() => {
              throw new Error("Replacement skipped its previous manager's close");
            }),
          ]);
        }
        cwd.mockReturnValue(path.join(root, "other"));
        release.resolve();
        const result = await creating;
        expect(result.error).toBeUndefined();
        expect(result.manager).not.toBeNull();
        if (mode === "creation") {
          expect(result.manager?.status().dbPath).toBe(database.path);
        }
        await result.manager?.close?.();
      } finally {
        release.resolve();
        await Promise.allSettled([creating, blocker]);
      }
    },
  );

  it("rechecks retained writes against their original state owner after cwd changes", async () => {
    const acquired = await acquire(config, "cli");
    const manager = acquired.manager;
    if (!manager?.sync) {
      throw new Error(acquired.error ?? "Expected a writable memory manager");
    }
    await manager.sync({ reason: "baseline", force: true });
    const database = openDatabase();
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
