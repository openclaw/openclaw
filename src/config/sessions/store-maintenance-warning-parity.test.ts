import { expect, it } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function createMaintenanceArtifacts() {
  return {
    archiveRemovedSessionTranscripts: async () => new Set<string>(),
    cleanupArchivedSessionTranscripts: async () => {},
  };
}

it("leaves warn-mode rows unchanged and protects admitted work during enforcement", async () => {
  const now = Date.now();
  const createStore = (): Record<string, SessionEntry> => ({
    archived: { sessionId: "archived", updatedAt: now - 2, archivedAt: now },
    active: { sessionId: "active", updatedAt: now - 1 },
    recent: { sessionId: "recent", updatedAt: now },
  });
  const maintenanceConfig = {
    mode: "warn" as const,
    pruneAfterMs: 30 * DAY_MS,
    maxEntries: 1,
    modelRunPruneAfterMs: DAY_MS,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
  };
  const shared = {
    storePath: "/tmp/openclaw-sessions/warn-enforce-parity.json",
    log: { warn: () => {}, info: () => {} },
    artifacts: createMaintenanceArtifacts(),
  };
  const admission = await beginSessionWorkAdmission({
    scope: shared.storePath,
    identities: ["active"],
    assertAllowed: () => {},
  });
  try {
    const warnedStore = createStore();
    await applyFileBackedSessionStoreMaintenance({
      ...shared,
      store: warnedStore,
      maintenanceConfig,
    });
    expect(warnedStore).toEqual(createStore());

    const enforcedStore = createStore();
    await applyFileBackedSessionStoreMaintenance({
      ...shared,
      store: enforcedStore,
      maintenanceConfig: { ...maintenanceConfig, mode: "enforce" },
    });

    expect(enforcedStore).toHaveProperty("archived");
    expect(enforcedStore).toHaveProperty("active");
    expect(enforcedStore.active?.archivedAt).toBeUndefined();
    expect(enforcedStore.recent?.archivedAt).toEqual(expect.any(Number));
  } finally {
    admission.release();
  }
});
