// Context-engine quarantine health tests cover cross-process status visibility.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  clearPersistedContextEngineQuarantineForProcess,
  recordPersistedContextEngineQuarantine,
} from "./quarantine-health.js";
import { clearContextEngineRuntimeQuarantine, listContextEngineQuarantines } from "./registry.js";

const CONTEXT_ENGINE_QUARANTINE_OWNER_ID = "core:context-engine-quarantine-health";
const CONTEXT_ENGINE_QUARANTINE_NAMESPACE = "runtime-quarantines";

type ContextEngineQuarantineTestRecord = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  recordedAtMs: number;
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

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("context engine quarantine health", () => {
  it("lists persisted runtime quarantines when local process state is empty", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
      clearContextEngineRuntimeQuarantine();
      recordPersistedContextEngineQuarantine({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "intentional bootstrap failure",
        failedAt: new Date(123),
      });

      expect(listContextEngineQuarantines()).toEqual([
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

  it("clears only the current process record while preserving live sibling quarantines", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
      await withLiveSiblingProcess(async (siblingProcessId) => {
        seedPersistedContextEngineQuarantineForTest({
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "current process failure",
          failedAtMs: 123,
          processId: process.pid,
          recordedAtMs: 456,
        });
        seedPersistedContextEngineQuarantineForTest({
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "sibling process failure",
          failedAtMs: 789,
          processId: siblingProcessId,
          recordedAtMs: 1_000,
        });

        clearPersistedContextEngineQuarantineForProcess("lossless-claw", process.pid);

        expect(listContextEngineQuarantines()).toEqual([
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
  });

  it("clears all current process records while preserving live sibling quarantines", async () => {
    await withStateDirEnv("openclaw-context-engine-quarantine-", async () => {
      await withLiveSiblingProcess(async (siblingProcessId) => {
        seedPersistedContextEngineQuarantineForTest({
          engineId: "local-a",
          operation: "bootstrap",
          reason: "current process failure a",
          failedAtMs: 123,
          processId: process.pid,
          recordedAtMs: 456,
        });
        seedPersistedContextEngineQuarantineForTest({
          engineId: "local-b",
          operation: "assemble",
          reason: "current process failure b",
          failedAtMs: 234,
          processId: process.pid,
          recordedAtMs: 567,
        });
        seedPersistedContextEngineQuarantineForTest({
          engineId: "lossless-claw",
          owner: "plugin:lossless-claw",
          operation: "bootstrap",
          reason: "sibling process failure",
          failedAtMs: 789,
          processId: siblingProcessId,
          recordedAtMs: 1_000,
        });

        clearContextEngineRuntimeQuarantine();

        expect(listContextEngineQuarantines()).toEqual([
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
  });
});
