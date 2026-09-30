// Context-engine quarantine health tests cover cross-process status visibility.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import * as pluginStateWorker from "../plugin-state/plugin-state-worker-client.js";
import { createRuntimeHealthRecordEnvelope } from "../plugin-state/runtime-health-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getProcessStartTime } from "../shared/pid-alive.js";
import { seedNativeVersionZeroState } from "../state/native-version-zero.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { MockContextEngine } from "./context-engine.test-support.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  listPersistedContextEngineQuarantines,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";
import { recordContextEngineQuarantine } from "./registry-quarantine.js";
import { listContextEngineQuarantines, registerContextEngineForOwner } from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "./registry.test-support.js";

const CONTEXT_ENGINE_QUARANTINE_OWNER_ID = "core:context-engine-quarantine-health";
const CONTEXT_ENGINE_QUARANTINE_NAMESPACE = "runtime-quarantines";

// Sibling records need a verifiable /proc starttime, so sibling-visibility
// coverage only runs where that identity source exists.
const hasProcessStartTimes = process.platform === "linux";

type ContextEngineQuarantineTestRecord = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  processToken: string;
  processStartTime: number | null;
};

async function withLiveSiblingProcess<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    stdio: "ignore",
  });
  if (!child.pid) {
    throw new Error("failed to start live sibling process");
  }
  try {
    return await fn(child.pid);
  } finally {
    child.kill();
  }
}

function seedPersistedContextEngineQuarantineForTest(
  record: ContextEngineQuarantineTestRecord,
): void {
  createCorePluginStateSyncKeyedStore<ContextEngineQuarantineTestRecord>({
    ownerId: CONTEXT_ENGINE_QUARANTINE_OWNER_ID,
    namespace: CONTEXT_ENGINE_QUARANTINE_NAMESPACE,
    maxEntries: 64,
  }).register(JSON.stringify([record.engineId, record.processId]), record);
}

function seedSiblingQuarantineForTest(params: {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  processStartTime: number | null;
}): void {
  seedPersistedContextEngineQuarantineForTest({
    ...params,
    processToken: "sibling-process-token",
  });
}

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("context engine quarantine health", () => {
  it("lists persisted runtime quarantines when local process state is empty", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
      await resetContextEngineRuntimeQuarantineForTests();
      await recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "intentional bootstrap failure",
        failedAt: new Date(123),
      });

      expect(await listContextEngineQuarantines()).toEqual([
        {
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "intentional bootstrap failure",
          failedAt: new Date(123),
        },
      ]);
    });
  });

  it("does not create state while clearing an absent health mirror", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-absent-", async ({ stateDir }) => {
      expect(readdirSync(stateDir)).toEqual([]);
      await clearPersistedContextEngineQuarantineForProcess(undefined, process.pid);
      expect(readdirSync(stateDir)).toEqual([]);
    });
  });

  it("does not adopt native-only state while clearing an absent health mirror", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-native-", async ({ stateDir }) => {
      const { DatabaseSync } = requireNodeSqlite();
      const databasePath = resolveOpenClawStateSqlitePath();
      expect(databasePath.startsWith(`${stateDir}${path.sep}`)).toBe(true);
      mkdirSync(path.dirname(databasePath), { recursive: true });
      const schemaSql = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
      const before = (() => {
        const database = new DatabaseSync(databasePath);
        try {
          seedNativeVersionZeroState(database, false);
          return database.prepare(schemaSql).all();
        } finally {
          database.close();
        }
      })();
      await clearPersistedContextEngineQuarantineForProcess(undefined, process.pid);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
        expect(database.prepare(schemaSql).all()).toEqual(before);
      } finally {
        database.close();
      }
    });
  });

  it.each([false, true])(
    "keeps accepted registration when its health cleanup is superseded (%s)",
    async (superseded) => {
      await withStateDirEnv("openclaw-context-engine-registration-", async () => {
        const previous = captureActivePluginRegistrySnapshot();
        const registry = previous.activeRegistry ?? createEmptyPluginRegistry();
        if (!previous.activeRegistry) {
          setActivePluginRegistry(registry);
        }
        const publication = captureActivePluginRegistrySnapshot();
        const engineId = `health-registration-${superseded}`;
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const quarantine = await recordContextEngineQuarantine({
          engineId,
          operation: "resolve",
          error: new Error("not registered"),
          defaultEngineId: "legacy",
        });
        const reached = createDeferredCore();
        const release = createDeferredCore();
        const clear = pluginStateWorker.clearRuntimeHealthInWorker;
        const observer = vi
          .spyOn(pluginStateWorker, "clearRuntimeHealthInWorker")
          .mockImplementation(async (params) => {
            reached.resolve();
            await release.promise;
            await clear(params);
          });
        const registration = registerContextEngineForOwner(
          engineId,
          () => new MockContextEngine(),
          "test:health-registration",
        );
        const observed = registration.then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await reached.promise;
          if (superseded) {
            stageActivePluginRegistry(
              createEmptyPluginRegistry(),
              null,
              publication.runtimeSubagentMode,
              publication.workspaceDir ?? undefined,
            );
          }
          release.resolve();
          expect(await observed).toEqual({ result: { ok: true } });
          expect(registry.contextEngines.get(engineId)?.owner).toBe("test:health-registration");
          expect(await listPersistedContextEngineQuarantines()).toEqual(
            superseded ? [quarantine] : [],
          );
          if (superseded) {
            // The in-memory quarantine is gone, so only the owner's record of
            // what it persisted lets the next registration retry the clear.
            await registerContextEngineForOwner(
              engineId,
              () => new MockContextEngine(),
              "test:health-registration",
            );
            expect(await listPersistedContextEngineQuarantines()).toEqual([]);
          }
        } finally {
          release.resolve();
          await observed;
          observer.mockRestore();
          consoleError.mockRestore();
          await resetContextEngineRuntimeQuarantineForTests();
          registry.contextEngines.delete(engineId);
          restoreActivePluginRegistrySnapshot(previous);
        }
      });
    },
  );

  it.runIf(hasProcessStartTimes)(
    "clears only the current process record while preserving live sibling quarantines",
    async () => {
      await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
        await withLiveSiblingProcess(async (siblingProcessId) => {
          seedPersistedContextEngineQuarantineForTest({
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "current process failure",
            ...createRuntimeHealthRecordEnvelope(new Date(123)),
          });
          seedSiblingQuarantineForTest({
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "sibling process failure",
            failedAtMs: 789,
            processId: siblingProcessId,
            processStartTime: getProcessStartTime(siblingProcessId),
          });

          await clearPersistedContextEngineQuarantineForProcess("lossless-claw", process.pid);

          expect(await listContextEngineQuarantines()).toEqual([
            {
              engineId: "lossless-claw",
              owner: "plugin:lossless-claw",
              operation: "bootstrap",
              reason: "sibling process failure",
              failedAt: new Date(789),
            },
          ]);
        });
      });
    },
  );

  it.runIf(hasProcessStartTimes)(
    "clears all current process records while preserving live sibling quarantines",
    async () => {
      await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
        await withLiveSiblingProcess(async (siblingProcessId) => {
          seedPersistedContextEngineQuarantineForTest({
            engineId: "local-a",
            operation: "bootstrap",
            reason: "current process failure a",
            ...createRuntimeHealthRecordEnvelope(new Date(123)),
          });
          seedPersistedContextEngineQuarantineForTest({
            engineId: "local-b",
            operation: "assemble",
            reason: "current process failure b",
            ...createRuntimeHealthRecordEnvelope(new Date(234)),
          });
          seedSiblingQuarantineForTest({
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "sibling process failure",
            failedAtMs: 789,
            processId: siblingProcessId,
            processStartTime: getProcessStartTime(siblingProcessId),
          });

          await resetContextEngineRuntimeQuarantineForTests();

          expect(await listContextEngineQuarantines()).toEqual([
            {
              engineId: "lossless-claw",
              owner: "plugin:lossless-claw",
              operation: "bootstrap",
              reason: "sibling process failure",
              failedAt: new Date(789),
            },
          ]);
        });
      });
    },
  );

  it("drops records from a previous incarnation of this PID", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-incarnation-", async () => {
      await resetContextEngineRuntimeQuarantineForTests();
      seedPersistedContextEngineQuarantineForTest({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "stale pre-restart failure",
        ...createRuntimeHealthRecordEnvelope(new Date(123)),
        processToken: "stale-incarnation-token",
      });

      expect(await listContextEngineQuarantines()).toEqual([]);
    });
  });

  it.runIf(hasProcessStartTimes)(
    "drops persisted quarantine records when a sibling PID has been reused",
    async () => {
      await withStateDirEnv("openclaw-context-engine-quarantine-pid-reuse-", async () => {
        await withLiveSiblingProcess(async (siblingProcessId) => {
          await resetContextEngineRuntimeQuarantineForTests();
          const siblingStartTime = getProcessStartTime(siblingProcessId);
          seedSiblingQuarantineForTest({
            engineId: "lossless-claw",
            owner: "plugin:lossless-claw",
            operation: "bootstrap",
            reason: "stale process failure",
            failedAtMs: 123,
            processId: siblingProcessId,
            processStartTime: siblingStartTime === null ? 1 : siblingStartTime + 1,
          });

          expect(await listContextEngineQuarantines()).toEqual([]);
        });
      });
    },
  );

  it("drops sibling records whose process identity cannot be verified", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-unverified-", async () => {
      await withLiveSiblingProcess(async (siblingProcessId) => {
        await resetContextEngineRuntimeQuarantineForTests();
        // A null recorded start time (non-Linux recorder or /proc read failure)
        // must fail closed instead of trusting bare PID liveness.
        seedSiblingQuarantineForTest({
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "unverifiable recorder identity",
          failedAtMs: 123,
          processId: siblingProcessId,
          processStartTime: null,
        });

        expect(await listContextEngineQuarantines()).toEqual([]);
      });
    });
  });
});
