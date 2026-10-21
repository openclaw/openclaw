import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { loadSessionEntry } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import {
  createSessionMaintenanceKickStore,
  observeSessionMaintenancePlanningWorker,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:age-kick";
const day = 86_400_000;

function observeMaintenanceCompletion(databasePath: string) {
  const completed = createDeferred();
  const release = maintenance.releaseSessionEntryMaintenanceExecution;
  const observer = vi
    .spyOn(maintenance, "releaseSessionEntryMaintenanceExecution")
    .mockImplementation((pathname, owner) => {
      release(pathname, owner);
      if (pathname === databasePath && owner.release) {
        void owner.release.then(completed.resolve, completed.reject);
      }
    });
  return (signal: AbortSignal) =>
    withinTest(completed.promise, signal).finally(() => observer.mockRestore());
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createCapBatchStore(protectedOnly = false, afterPlan?: () => void | Promise<void>) {
  const fixture = createSessionMaintenanceKickStore({
    storePath: path.join(tempDirs.make("session-maintenance-cap-"), "agent.sqlite"),
    key: sessionKey,
    pruneAfterMs: 86_400_000,
    workerMaintenance: true,
    maintenanceScopes: [],
  });
  fixture.request.maintenanceConfig.maxEntries = 100;
  vi.useRealTimers();
  const keys = Array.from({ length: 179 }, (_, index) => `agent:main:cap-batch-${index}`);
  runOpenClawAgentWriteTransaction((database) => {
    if (protectedOnly) {
      writeSessionEntry(database, sessionKey, {
        sessionId: "age-kick",
        updatedAt: fixture.updatedAt,
        modelSelectionLocked: true,
      });
    }
    keys.forEach((key, index) => {
      writeSessionEntry(database, key, {
        sessionId: `cap-batch-${index}`,
        ...(protectedOnly ? { modelSelectionLocked: true } : {}),
        updatedAt: fixture.updatedAt - keys.length + index,
      });
    });
  }, fixture.scope);
  const plans: SessionEntryMaintenancePlan[] = [];
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  dispatch.mockImplementation(async (params) => {
    const result = await run(params);
    if (result.kind === "maintenance-plan") {
      plans.push(result.value);
      await afterPlan?.();
    }
    return result;
  });
  return { ...fixture, keys, plans };
}

function createAgeBatchStore(
  count: number,
  options: {
    protectedPrefix?: number;
    pruneAfterMs?: number;
    afterPlan?: () => void | Promise<void>;
  } = {},
) {
  const pruneAfterMs = options.pruneAfterMs ?? day;
  const fixture = createSessionMaintenanceKickStore({
    storePath: path.join(tempDirs.make("session-maintenance-age-batch-"), "agent.sqlite"),
    key: sessionKey,
    pruneAfterMs,
    workerMaintenance: true,
    maintenanceScopes: [],
  });
  fixture.request.maintenanceConfig.maxEntries = count + 100;
  vi.useRealTimers();
  const keys = Array.from(
    { length: count },
    (_, index) => `agent:main:age-batch-${String(index).padStart(3, "0")}`,
  );
  runOpenClawAgentWriteTransaction((database) => {
    keys.forEach((key, index) => {
      writeSessionEntry(database, key, {
        sessionId: `age-batch-${index}`,
        updatedAt: fixture.updatedAt - 2 * pruneAfterMs + index,
        ...(index < (options.protectedPrefix ?? 0) ? { modelSelectionLocked: true } : {}),
      });
    });
  }, fixture.scope);
  const plans: SessionEntryMaintenancePlan[] = [];
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  dispatch.mockImplementation(async (params) => {
    const result = await run(params);
    if (result.kind === "maintenance-plan") {
      plans.push(result.value);
      await options.afterPlan?.();
    }
    return result;
  });
  return { ...fixture, keys, plans };
}

it.for([0, 70])(
  "bounds automatic age retention and drains past %s protected entries",
  async (protectedPrefix, { signal }) => {
    const { request, storePath, keys, plans } = createAgeBatchStore(500, { protectedPrefix });
    const completed = observeMaintenanceCompletion(storePath);
    kickSessionEntryMaintenanceAfterWrite(request);
    await completed(signal);

    expect(plans.length).toBeGreaterThan(1);
    expect(plans.every((plan) => plan.archived <= 64)).toBe(true);
    expect(plans.every((plan) => plan.capArchived === 0)).toBe(true);
    const archived = keys.filter(
      (key) => loadSessionEntry({ storePath, sessionKey: key })?.archiveReason === "age-retention",
    );
    expect(archived).toEqual(keys.slice(protectedPrefix));
    expect(plans.flatMap((plan) => plan.archivedEntries.map((entry) => entry.sessionKey))).toEqual(
      archived,
    );
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    if (protectedPrefix > 64) {
      expect(plans[0]).toMatchObject({ archived: 0, entryRemovals: [] });
      for (const key of keys.slice(0, protectedPrefix)) {
        expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
      }
    }
  },
);

it.for(["victim", "remaining"] as const)(
  "releases the age writer between batches and honors new protection (%s)",
  async (protection, { signal }) => {
    let protectedKeys: string[] = [];
    let releases = 0;
    let foreground: Promise<unknown> | undefined;
    const { request, storePath, keys, plans } = createAgeBatchStore(150, {
      async afterPlan() {
        if (++releases === 1) {
          protectedKeys = protection === "remaining" ? keys.slice(64) : [keys[64]!];
          await withinTest(foreground!, signal);
        }
      },
    });
    const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
      capture: () => protectedKeys,
      dispose() {},
    }));
    let commits = 0;
    let foregroundCompleted = false;
    observeSessionMaintenancePlanningWorker({
      afterExecute(result) {
        if (result.kind === "committed" && ++commits === 1) {
          foreground = patchSessionEntryCore(
            { storePath, sessionKey },
            () => ({ label: "foreground between age batches" }),
            { skipMaintenance: true },
          ).then(() => {
            foregroundCompleted = true;
          });
        }
      },
      beforeExecute() {
        if (commits > 0) {
          expect(foregroundCompleted).toBe(true);
        }
      },
    });
    try {
      const completed = observeMaintenanceCompletion(storePath);
      kickSessionEntryMaintenanceAfterWrite(request);
      await completed(signal);
      expect(plans.every((plan) => plan.archived <= 64)).toBe(true);
      const archived = keys.filter(
        (key) => loadSessionEntry({ storePath, sessionKey: key })?.archivedAt,
      );
      expect(archived).toEqual(
        protection === "remaining" ? keys.slice(0, 64) : keys.filter((key) => key !== keys[64]),
      );
      expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe(
        "foreground between age batches",
      );
      expect(loadSessionEntry({ storePath, sessionKey: keys[64]! })?.archivedAt).toBeUndefined();
    } finally {
      unregister();
    }
  },
);

it("finishes age retention before cap selection and preserves the initial model-run pressure", async ({
  signal,
}) => {
  const { request, scope, storePath, keys, plans, updatedAt } = createAgeBatchStore(128, {
    pruneAfterMs: 30 * day,
  });
  request.maintenanceConfig.maxEntries = 3;
  request.maintenanceConfig.modelRunPruneAfterMs = day;
  const modelRunKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
  const recentKeys = ["agent:main:recent-a", "agent:main:recent-b"];
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, modelRunKey, {
      sessionId: "age-pressure-model-run",
      updatedAt: updatedAt - 2 * day,
    });
    for (const key of recentKeys) {
      writeSessionEntry(database, key, { sessionId: key, updatedAt });
    }
  }, scope);
  const completed = observeMaintenanceCompletion(storePath);
  kickSessionEntryMaintenanceAfterWrite(request);
  await completed(signal);

  expect(plans.every((plan) => plan.capArchived === 0)).toBe(true);
  expect(plans.reduce((total, plan) => total + plan.modelRunPruned, 0)).toBe(1);
  for (const key of keys) {
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archiveReason).toBe("age-retention");
  }
  expect(loadSessionEntry({ storePath, sessionKey: modelRunKey })).toBeUndefined();
  for (const key of [sessionKey, ...recentKeys]) {
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
  }
});

it("carries referenced history into the last automatic age page before reclaiming it", async ({
  signal,
}) => {
  const fixture = createSessionMaintenanceKickStore({
    storePath: path.join(tempDirs.make("session-maintenance-age-history-"), "agent.sqlite"),
    key: sessionKey,
    pruneAfterMs: day,
    workerMaintenance: true,
    maintenanceScopes: [],
  });
  fixture.request.maintenanceConfig.maxEntries = 1_000;
  vi.useRealTimers();
  const keys = Array.from(
    { length: 65 },
    (_, index) => `agent:main:subagent:age-history-${String(index).padStart(3, "0")}`,
  );
  const historyId = "age-shared-history";
  const event = { type: "session", id: historyId, content: "retained across the first page" };
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, keys[0]!, { sessionId: historyId, updatedAt: 1 });
    appendTranscriptEventsInTransaction(
      database,
      { ...fixture.scope, sessionKey: keys[0]!, sessionId: historyId },
      [event],
    );
    keys.forEach((key, index) => {
      writeSessionEntry(database, key, {
        sessionId: `age-history-${index}`,
        updatedAt: fixture.updatedAt - 2 * day + index,
        ...(index === 0 || index === 64 ? { previousSessionId: historyId } : {}),
      });
    });
  }, fixture.scope);
  const plans: SessionEntryMaintenancePlan[] = [];
  let retainedBetweenPages = false;
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  dispatch.mockImplementation(async (params) => {
    if (params.plan.kind === "maintenance-plan" && plans.length === 1) {
      // The first page settled and removed its owner; the last victim still protects G.
      expect(
        loadSessionEntry({ storePath: fixture.storePath, sessionKey: keys[0]! }),
      ).toBeUndefined();
      expect(
        loadSessionEntry({ storePath: fixture.storePath, sessionKey: keys[64]! }),
      ).toBeDefined();
      expect(
        fixture.database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get(historyId),
      ).toEqual({ session_key: keys[64] });
      expect(
        fixture.database.db
          .prepare("SELECT count(*) AS n FROM transcript_events WHERE session_id = ?")
          .get(historyId),
      ).toEqual({ n: 1 });
      expect(
        fixture.database.db
          .prepare("SELECT session_id FROM session_transcript_archives WHERE session_id = ?")
          .get(historyId),
      ).toBeUndefined();
      retainedBetweenPages = true;
    }
    const result = await run(params);
    if (result.kind === "maintenance-plan") {
      plans.push(result.value);
    }
    return result;
  });
  const completed = observeMaintenanceCompletion(fixture.storePath);
  kickSessionEntryMaintenanceAfterWrite(fixture.request);
  await completed(signal);

  expect(retainedBetweenPages).toBe(true);
  expect(
    plans.filter((plan) => plan.entryRemovals.length > 0).map((plan) => plan.entryRemovals.length),
  ).toEqual([64, 1]);
  for (const key of keys) {
    expect(loadSessionEntry({ storePath: fixture.storePath, sessionKey: key })).toBeUndefined();
  }
  expect(
    fixture.database.db
      .prepare("SELECT count(*) AS n FROM transcript_events WHERE session_id = ?")
      .get(historyId),
  ).toEqual({ n: 0 });
  expect(
    fixture.database.db
      .prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
      .get(historyId),
  ).toBeUndefined();
  expect(
    fixture.database.db
      .prepare(
        "SELECT session_id, published_at FROM session_transcript_archives WHERE session_id = ?",
      )
      .get(historyId),
  ).toEqual({ session_id: historyId, published_at: expect.any(Number) });
  expect(
    loadSessionEntry({ storePath: fixture.storePath, sessionKey })?.archivedAt,
  ).toBeUndefined();
});

it.for(["automatic", "inline", "protected"] as const)(
  "bounds cap work and finishes eligible capacity maintenance (%s)",
  async (owner, { signal }) => {
    const { request, scope, storePath, keys, plans } = createCapBatchStore(owner === "protected");
    if (owner === "inline") {
      plans.push(
        runOpenClawAgentWriteTransaction(
          (database) =>
            maintenance.applySessionEntryMaintenance(database, {
              activeSessionKey: sessionKey,
              archiveDirectory: request.archiveDirectory,
              forceMaintenance: true,
              maintenanceConfig: request.maintenanceConfig,
              preservation: () => ({
                providerKeys: [],
                workIdentities: [],
                lifecycleIdentities: [],
              }),
              storePath,
            }),
          scope,
        ),
      );
    } else {
      const completed = observeMaintenanceCompletion(storePath);
      kickSessionEntryMaintenanceAfterWrite(request);
      await completed(signal);
    }
    // The first automatic batch leaves 116 entries, below high-water 125 but above cap 100.
    expect(plans.filter((plan) => plan.capArchived > 0).map((plan) => plan.capArchived)).toEqual(
      owner === "protected" ? [] : owner === "inline" ? [80] : [64, 16],
    );
    const archived = keys.filter(
      (key) => loadSessionEntry({ storePath, sessionKey: key })?.archivedAt,
    );
    expect(archived).toEqual(owner === "protected" ? [] : keys.slice(0, 80));
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect(plans.flatMap((plan) => plan.archivedEntries.map((entry) => entry.sessionKey))).toEqual(
      archived,
    );
  },
);

it.for(["victim", "remaining"] as const)(
  "releases the cap writer between batches and honors new protection (%s)",
  async (protection, { signal }) => {
    let protectedKeys: string[] = [];
    let releases = 0;
    let foreground: Promise<unknown> | undefined;
    const { request, storePath, keys, plans } = createCapBatchStore(false, async () => {
      if (++releases === 1) {
        protectedKeys = protection === "remaining" ? [sessionKey, ...keys.slice(64)] : [keys[64]!];
        await withinTest(foreground!, signal);
      }
    });
    const protectedKey = keys[64]!;
    const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
      capture: () => protectedKeys,
      dispose() {},
    }));
    let commits = 0;
    let foregroundCompleted = false;
    observeSessionMaintenancePlanningWorker({
      afterExecute(result) {
        if (result.kind === "committed" && ++commits === 1) {
          // Queue under the first operation; await only after its FIFO custody is released.
          foreground = patchSessionEntryCore(
            { storePath, sessionKey },
            () => ({ label: "foreground between cap batches" }),
            { skipMaintenance: true },
          ).then(() => {
            foregroundCompleted = true;
          });
        }
      },
      beforeExecute() {
        if (commits > 0) {
          expect(foregroundCompleted).toBe(true);
        }
      },
    });
    try {
      const completed = observeMaintenanceCompletion(storePath);
      kickSessionEntryMaintenanceAfterWrite(request);
      await completed(signal);
      expect(plans.filter((plan) => plan.capArchived > 0).map((plan) => plan.capArchived)).toEqual(
        protection === "remaining" ? [64] : [64, 16],
      );
      if (protection === "remaining") {
        expect(plans.at(-1)).toMatchObject({ capped: 0, archived: 0, entryRemovals: [] });
      }
      expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe(
        "foreground between cap batches",
      );
      expect(loadSessionEntry({ storePath, sessionKey: protectedKey })?.archivedAt).toBeUndefined();
      const archived = keys.filter(
        (key) => loadSessionEntry({ storePath, sessionKey: key })?.archivedAt,
      );
      expect(archived).toEqual(
        protection === "remaining"
          ? keys.slice(0, 64)
          : keys.slice(0, 81).filter((key) => key !== protectedKey),
      );
    } finally {
      unregister();
    }
  },
);

it("keeps the first cap receipt and stops later batches when maintenance authority retires", async ({
  signal,
}) => {
  const retired = createDeferred();
  let releases = 0;
  const { database, request, storePath, keys, plans } = createCapBatchStore(false, () => {
    if (++releases === 1) {
      markGatewayRestartDraining();
      retired.resolve();
    }
  });
  kickSessionEntryMaintenanceAfterWrite(request);
  await withinTest(retired.promise, signal);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  expect(plans.map((plan) => plan.capArchived)).toEqual([64]);
  const archived = keys.filter(
    (key) => loadSessionEntry({ storePath, sessionKey: key })?.archivedAt,
  );
  expect(archived).toEqual(keys.slice(0, 64));
});
