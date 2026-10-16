import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import * as logging from "../../logging/logger.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { loadSessionEntry, loadTranscriptEvents } from "./session-accessor.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import {
  createSessionMaintenanceKickStore,
  observeSessionMaintenancePlanningWorker,
  observeSessionMaintenanceChanges,
  observeNextPeriodicMaintenance,
  countPlanningPasses,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:age-kick";
const maintenanceScopes: ReturnType<typeof createOpenClawDatabaseMaintenanceScope>[] = [];

afterEach(async () => {
  await agentDatabase.closeOpenClawAgentDatabasesAsync();
  for (const maintenance of maintenanceScopes.splice(0)) {
    await maintenance.close();
  }
  closeOpenClawAgentDatabasesForTest();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createStore(pruneAfterMs = 1_000, key = sessionKey, { workerMaintenance = false } = {}) {
  return createSessionMaintenanceKickStore({
    storePath: path.join(tempDirs.make("session-maintenance-kick-"), "agent.sqlite"),
    key,
    pruneAfterMs,
    workerMaintenance,
    maintenanceScopes,
  });
}

it("joins automatic worker maintenance while Doctor drainage waits on other work", async () => {
  const { request } = createStore(1_000, sessionKey, { workerMaintenance: true });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess() {},
  });
  const blocked = createDeferred();
  void maintenance.track(blocked.promise);
  const warn = vi.spyOn(logging.getChildLogger({ subsystem: "session-sqlite" }), "warn");
  const observation = observeHostDataSql();
  maintenance.run(() => kickSessionEntryMaintenanceAfterWrite(request));
  const closing = maintenance.close();
  try {
    await yieldToEventLoop();
    blocked.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(reclamationRun.runSqliteSessionReclamation).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(observation.queries.filter(isSessionEntryDataSql)).toEqual([]);
  } finally {
    blocked.resolve();
    await Promise.allSettled([closing]);
    observation.restore();
  }
});

it("revisits write-protected capacity victims after their captured keys are released", async ({
  signal,
}) => {
  const { request, scope, storePath, archived, planned, updatedAt } = createStore(
    86_400_000,
    sessionKey,
    {
      workerMaintenance: true,
    },
  );
  request.maintenanceConfig.maxEntries = 1;
  const protectedKey = "agent:main:locked-capacity-owner";
  const partialKey = "agent:main:partial-capacity-victim";
  vi.useRealTimers();
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, protectedKey, {
      sessionId: "locked-capacity-owner",
      updatedAt,
      modelSelectionLocked: true,
    });
    writeSessionEntry(database, partialKey, {
      sessionId: "partial-capacity-victim",
      updatedAt,
    });
  }, scope);
  const remainingArchived = observeSessionMaintenanceChanges(storePath, sessionKey);
  kickSessionEntryMaintenanceAfterWrite(request);
  await withinTest(planned, signal);
  await withinTest(archived, signal);
  expect(loadSessionEntry({ storePath, sessionKey: partialKey })?.archiveReason).toBe(
    "active-session-cap",
  );
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  await withinTest(remainingArchived, signal);
  expect(loadSessionEntry({ storePath, sessionKey })?.archiveReason).toBe("active-session-cap");
  expect(loadSessionEntry({ storePath, sessionKey: protectedKey })?.archivedAt).toBeUndefined();
});

it("resumes idle capacity maintenance when acquired work releases without another write", async ({
  signal,
}) => {
  const { request, scope, storePath, archived, planned, updatedAt } = createStore(
    86_400_000,
    sessionKey,
    { workerMaintenance: true },
  );
  request.maintenanceConfig.maxEntries = 1;
  const protectedKey = "agent:main:admission-locked-capacity-owner";
  const partialKey = "agent:main:admission-partial-capacity-victim";
  vi.useRealTimers();
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, protectedKey, {
      sessionId: "admission-locked-capacity-owner",
      updatedAt,
      modelSelectionLocked: true,
    });
    writeSessionEntry(database, partialKey, {
      sessionId: "admission-partial-capacity-victim",
      updatedAt,
    });
  }, scope);
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, "age-kick"],
  });
  const partialAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [partialKey, "admission-partial-capacity-victim"],
  });
  try {
    const settled = observeNextPeriodicMaintenance(
      (delay) => delay >= ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS / 2,
    );
    const remainingArchived = observeSessionMaintenanceChanges(storePath, sessionKey);
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(planned, signal);
    await settled(signal);
    expect(loadSessionEntry({ storePath, sessionKey: partialKey })?.archivedAt).toBeUndefined();
    const partialSettled = observeNextPeriodicMaintenance(
      (delay) => delay >= ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS / 2,
    );
    partialAdmission.release();
    await withinTest(archived, signal);
    await partialSettled(signal);
    expect(loadSessionEntry({ storePath, sessionKey: partialKey })?.archiveReason).toBe(
      "active-session-cap",
    );
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    admission.release();
    await withinTest(remainingArchived, signal);
    expect(loadSessionEntry({ storePath, sessionKey })?.archiveReason).toBe("active-session-cap");
    expect(loadSessionEntry({ storePath, sessionKey: protectedKey })?.archivedAt).toBeUndefined();
  } finally {
    partialAdmission.release();
    admission.release();
  }
});

it.for(["young", "capacity", "expired"] as const)(
  "uses delivery settlement facts to schedule a %s store",
  async (scenario, { signal }) => {
    const { request, scope, storePath, updatedAt, archived } = createStore(86_400_000, sessionKey, {
      workerMaintenance: true,
    });
    request.maintenanceConfig.maxEntries = scenario === "capacity" ? 1 : 10;
    request.maintenanceConfig.archiveDashboardAfterMs = scenario === "expired" ? 1_000 : null;
    const target = {
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:delivery-maintenance-victim",
      sessionId: "delivery-maintenance-victim",
    };
    runOpenClawAgentWriteTransaction((database) => {
      writeSessionEntry(database, sessionKey, {
        sessionId: "age-kick",
        updatedAt,
        modelSelectionLocked: true,
      });
      writeSessionEntry(database, target.sessionKey, {
        sessionId: target.sessionId,
        updatedAt: scenario === "expired" ? updatedAt - 2_000 : updatedAt,
        pendingFinalDelivery: {
          kind: "transport-only",
          createdAt: updatedAt,
          intentId: "maintenance-intent",
          deliveries: [{ id: "maintenance-delivery", state: "prepared" }],
        },
      });
    }, scope);
    const manager = await SessionManager.openAsync(target, path.dirname(storePath));
    const message = {
      role: "user" as const,
      content: "Synthetic input delivery-maintenance",
      timestamp: 1,
      idempotencyKey: "delivery-maintenance:user",
    };
    await manager.appendMessageAsync(message);
    const settled = createDeferred();
    const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
    const run = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (params) => {
      const result = await run(params);
      if (result.kind === "maintenance-plan") {
        settled.resolve();
      }
      return result;
    });
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(settled.promise, signal);
    await yieldToEventLoop();
    const protectedPasses = countPlanningPasses();
    expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeDefined();
    await withinTest(
      settlePendingFinalDelivery(
        {
          ...target,
          kind: "pending-final",
          intentId: "maintenance-intent",
          deliveryId: "maintenance-delivery",
        },
        "delivered",
        undefined,
        { clearAfterSettled: {}, preserveActivity: true },
      ),
      signal,
    );
    expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeUndefined();
    await yieldToEventLoop();
    await vi.advanceTimersByTimeAsync(1_001);
    if (scenario === "young") {
      kickSessionEntryMaintenanceAfterWrite(request);
      await yieldToEventLoop();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(countPlanningPasses()).toBe(protectedPasses);
      expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
    } else {
      expect(countPlanningPasses()).toBeGreaterThan(protectedPasses);
      await withinTest(archived, signal);
      expect(loadSessionEntry(target)?.archiveReason).toBe(
        scenario === "capacity" ? "active-session-cap" : "stale-dashboard",
      );
    }
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({ message });
  },
);

it.each(["unlock", "insert", "policy"] as const)(
  "backs off a protected over-cap store on activity and resumes after %s",
  async (change) => {
    const { request, scope, storePath, updatedAt } = createStore(60_000);
    request.maintenanceConfig.maxEntries = 2;
    const protectedKey = "agent:main:protected-cap";
    runOpenClawAgentWriteTransaction((owner) => {
      for (const key of [sessionKey, protectedKey, "agent:main:protected-other"]) {
        writeSessionEntry(owner, key, {
          sessionId: key === sessionKey ? "age-kick" : key,
          updatedAt,
          modelSelectionLocked: true,
        });
      }
    }, scope);
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    const passes = countPlanningPasses();
    expect(passes).toBeGreaterThan(0);
    for (let index = 0; index < 4; index++) {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, sessionKey, {
          sessionId: "age-kick",
          updatedAt,
          label: `activity-${index}`,
          modelSelectionLocked: true,
        });
      }, scope);
      kickSessionEntryMaintenanceAfterWrite(request);
      await yieldToEventLoop();
      await vi.advanceTimersByTimeAsync(1_001);
    }
    expect(countPlanningPasses()).toBe(passes);
    let victimKey = protectedKey;
    if (change === "policy") {
      request.maintenanceConfig.pruneAfterMs = 1_000;
    } else {
      victimKey = change === "insert" ? "agent:main:new-eligible" : protectedKey;
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, victimKey, { sessionId: victimKey, updatedAt });
      }, scope);
    }
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    expect(countPlanningPasses()).toBeGreaterThan(passes);
    if (change !== "policy") {
      expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archiveReason).toBe(
        "active-session-cap",
      );
    }
  },
);

it.for(["activity", "insert", "unlock", "remove", "policy"] as const)(
  "settles a consumed protected-only worker plan after %s during result delivery",
  async (change, { signal }) => {
    const { request, scope, storePath, updatedAt, archived } = createStore(86_400_000, sessionKey, {
      workerMaintenance: true,
    });
    request.maintenanceConfig.maxEntries = 1;
    const protectedKey = "agent:main:durable-worker-protected";
    const insertedKey = "agent:main:durable-worker-inserted";
    runOpenClawAgentWriteTransaction((owner) => {
      for (const key of [sessionKey, protectedKey]) {
        writeSessionEntry(owner, key, { sessionId: key, updatedAt, modelSelectionLocked: true });
      }
    }, scope);
    const writeActivity = () => {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, sessionKey, {
          sessionId: sessionKey,
          updatedAt: Date.now(),
          modelSelectionLocked: true,
          label: "ordinary activity",
        });
      }, scope);
      kickSessionEntryMaintenanceAfterWrite(request);
    };
    const firstPass = createDeferred();
    const nextPass = createDeferred();
    const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
    const run = dispatch.getMockImplementation()!;
    let delivered = false;
    dispatch.mockImplementation(async (params) => {
      const result = await run(params);
      if (!delivered && result.kind === "maintenance-plan") {
        expect(result.value.durableNoCandidates).toBe(true);
        delivered = true;
        if (change === "activity") {
          writeActivity();
        } else if (change === "policy") {
          request.maintenanceConfig.maxEntries = 2;
          kickSessionEntryMaintenanceAfterWrite(request);
        } else {
          runOpenClawAgentWriteTransaction((owner) => {
            if (change === "remove") {
              deleteSessionEntryRows(owner, protectedKey, { deleteOwnedWindows: true });
            } else {
              const key = change === "insert" ? insertedKey : protectedKey;
              writeSessionEntry(owner, key, { sessionId: key, updatedAt });
            }
          }, scope);
        }
        firstPass.resolve();
      } else if (delivered && result.kind === "maintenance-plan") {
        nextPass.resolve();
      }
      return result;
    });
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(firstPass.promise, signal);
    await yieldToEventLoop();
    const passes = countPlanningPasses();
    if (change !== "activity") {
      await vi.advanceTimersByTimeAsync(1_001);
      expect(countPlanningPasses()).toBeGreaterThan(passes);
      await withinTest(nextPass.promise, signal);
      if (change === "insert" || change === "unlock") {
        await withinTest(archived, signal);
        expect(
          loadSessionEntry({
            storePath,
            sessionKey: change === "insert" ? insertedKey : protectedKey,
          })?.archiveReason,
        ).toBe("active-session-cap");
      } else if (change === "remove") {
        expect(loadSessionEntry({ storePath, sessionKey: protectedKey })).toBeUndefined();
      } else {
        const latestPlan = dispatch.mock.calls
          .map(([{ plan }]) => plan)
          .findLast((plan) => plan.kind === "maintenance-plan");
        expect(
          latestPlan?.kind === "maintenance-plan" && latestPlan.input.maintenance.maxEntries,
        ).toBe(2);
      }
      return;
    }
    for (let index = 0; index < 4; index++) {
      writeActivity();
      await yieldToEventLoop();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(countPlanningPasses()).toBe(passes);
    }
  },
);

it("caps eligible entries when protected inserts overflow a previously below-cap store", async ({
  signal,
}) => {
  const { request, scope, storePath, updatedAt } = createStore(86_400_000);
  request.maintenanceConfig.maxEntries = 2;
  const victimKey = "agent:main:eligible-before-overflow";
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, sessionKey, {
      sessionId: "age-kick",
      updatedAt,
      modelSelectionLocked: true,
    });
    writeSessionEntry(owner, victimKey, { sessionId: "eligible-before-overflow", updatedAt });
  }, scope);
  const settled = observeNextPeriodicMaintenance();
  kickSessionEntryMaintenanceAfterWrite(request);
  await settled(signal);
  expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archivedAt).toBeUndefined();
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, "agent:main:protected-overflow", {
      sessionId: "protected-overflow",
      updatedAt,
      modelSelectionLocked: true,
    });
  }, scope);
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archiveReason).toBe(
    "active-session-cap",
  );
});

it("resumes an over-cap pass on ordinary activity after runtime protection releases", async ({
  signal,
}) => {
  const { request, scope, storePath, updatedAt, planned } = createStore(86_400_000);
  request.maintenanceConfig.maxEntries = 1;
  const victimKey = "agent:main:runtime-protected-cap";
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, sessionKey, {
      sessionId: "age-kick",
      updatedAt,
      modelSelectionLocked: true,
    });
    writeSessionEntry(owner, victimKey, { sessionId: "runtime-victim", updatedAt });
  }, scope);
  let keys = [victimKey];
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: () => keys,
    dispose() {},
  }));
  try {
    const settled = observeNextPeriodicMaintenance();
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(planned, signal);
    await yieldToEventLoop();
    await vi.advanceTimersByTimeAsync(1_001);
    await settled(signal);
    expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archivedAt).toBeUndefined();
    keys = [];
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, sessionKey, {
        sessionId: "age-kick",
        updatedAt,
        modelSelectionLocked: true,
        label: "ordinary activity",
      });
    }, scope);
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archiveReason).toBe(
      "active-session-cap",
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
  } finally {
    await agentDatabase.closeOpenClawAgentDatabasesAsync();
    unregister();
  }
});

it("keeps a pending maintenance retry bounded while ordinary writes continue", async ({
  signal,
}) => {
  const { request, scope, storePath, updatedAt } = createStore(86_400_000);
  request.maintenanceConfig.maxEntries = 1;
  const victimKey = "agent:main:quiet-retry-victim";
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, sessionKey, {
      sessionId: "age-kick",
      updatedAt,
      modelSelectionLocked: true,
    });
    writeSessionEntry(owner, victimKey, { sessionId: "quiet-retry-victim", updatedAt });
  }, scope);
  let keys = [victimKey];
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: () => keys,
    dispose() {},
  }));
  const writeActivity = (label: string) => {
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, sessionKey, {
        sessionId: "age-kick",
        updatedAt: Date.now(),
        modelSelectionLocked: true,
        label,
      });
    }, scope);
    kickSessionEntryMaintenanceAfterWrite(request);
  };
  const firstPass = createDeferred();
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  let released = false;
  dispatch.mockImplementation(async (params) => {
    const result = await run(params);
    if (!released && result.kind === "maintenance-plan") {
      expect(result.value.archived).toBe(0);
      expect(result.value.durableNoCandidates).not.toBe(true);
      released = true;
      keys = [];
      writeActivity("during result delivery");
      firstPass.resolve();
    }
    return result;
  });
  try {
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(firstPass.promise, signal);
    await yieldToEventLoop();
    for (let tick = 0; tick < 11; tick++) {
      await vi.advanceTimersByTimeAsync(100);
      writeActivity(`continued activity ${tick}`);
      await yieldToEventLoop();
    }
    expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archiveReason).toBe(
      "active-session-cap",
    );
  } finally {
    await agentDatabase.closeOpenClawAgentDatabasesAsync();
    unregister();
  }
});

it.each(["before immediate"] as const)(
  "stops automatic maintenance when Gateway drain starts %s",
  async () => {
    const { request } = createStore();
    const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
    kickSessionEntryMaintenanceAfterWrite(request);
    markGatewayRestartDraining("stop (SIGTERM)");
    await yieldToEventLoop();
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS + 1);
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it.each(["periodic"] as const)(
  "retires automatic maintenance when database admission is refused before its %s pass",
  async (when) => {
    const { request } = createStore();
    const warn = vi.spyOn(logging.getChildLogger({ subsystem: "session-sqlite" }), "warn");
    const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
    kickSessionEntryMaintenanceAfterWrite(request);
    if (when === "periodic") {
      await yieldToEventLoop();
      expect(
        dispatch.mock.calls.filter(([{ plan }]) => plan.kind === "maintenance-plan"),
      ).toHaveLength(1);
      dispatch.mockClear();
    }
    recordAgentDatabaseAdmissions(
      [
        {
          agentId: "main",
          paths: [request.storePath],
          code: "agent-database-inspection-pending",
          reason: "maintenance admission revoked",
          repairHint: "finish fixture inspection",
        },
      ],
      { source: "startup" },
    );
    try {
      await yieldToEventLoop();
      await vi.advanceTimersByTimeAsync(ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS + 1);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
    await vi.advanceTimersByTimeAsync(ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS + 1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  },
);

it.each([["a drain-refused commit", false]] as const)(
  "classifies %s that settles during Gateway drain",
  async (outcome, warns) => {
    const { request } = createStore();
    const logger = logging.getChildLogger({ subsystem: "session-sqlite" });
    vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
    const warn = vi.spyOn(logger, "warn");
    vi.mocked(reclamationRun.runSqliteSessionReclamation).mockImplementationOnce(async (params) => {
      markGatewayRestartDraining("stop (SIGTERM)");
      if (outcome === "a drain-refused commit") {
        params.assertCommitAllowed?.();
      }
      throw new Error("disk I/O error");
    });
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    await vi.advanceTimersByTimeAsync(1);
    const failure = expect.objectContaining({ error: expect.any(Error) });
    if (warns) {
      expect(warn).toHaveBeenCalledWith("SQLite automatic session maintenance failed", failure);
    } else {
      expect(warn).not.toHaveBeenCalledWith("SQLite automatic session maintenance failed", failure);
    }
  },
);

it("resumes automatic maintenance after Gateway work admission resets", async ({ signal }) => {
  const { request, storePath, archived } = createStore();
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  markGatewayRestartDraining("stop (SIGTERM)");
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  resetGatewayWorkAdmission();
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  dispatch.mockClear();
  const scheduled = observeNextPeriodicMaintenance(1_001);
  kickSessionEntryMaintenanceAfterWrite(request);
  await scheduled(signal);
  expect(dispatch.mock.calls.filter(([{ plan }]) => plan.kind === "maintenance-plan")).toHaveLength(
    1,
  );
  await vi.advanceTimersByTimeAsync(1_001);
  await withinTest(archived, signal);
  expect(loadSessionEntry({ sessionKey, storePath })?.archiveReason).toBe("age-retention");
});

it("does not dispatch maintenance in warn mode", async () => {
  const { request, storePath } = createStore();
  request.maintenanceConfig.mode = "warn";
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(reclamationRun.runSqliteSessionReclamation).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
});

it("wakes on new-entry pressure after keeping acknowledged inserts asleep", async ({ signal }) => {
  const { request, scope, updatedAt } = createStore(60_000);
  request.maintenanceConfig.maxEntries = 2;
  const initialized = observeNextPeriodicMaintenance(60_001);
  kickSessionEntryMaintenanceAfterWrite(request);
  await initialized(signal);
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  dispatch.mockClear();
  const insert = (index: number) => {
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, `agent:main:insert-${index}`, {
        sessionId: `insert-${index}`,
        updatedAt,
      });
    }, scope);
    kickSessionEntryMaintenanceAfterWrite(request);
  };
  insert(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(dispatch).not.toHaveBeenCalled();
  insert(2);
  await yieldToEventLoop();
  expect(dispatch.mock.calls.some(([{ plan }]) => plan.kind === "maintenance-plan")).toBe(true);
});

it("commits an automatic plan while unrelated writes arrive every 100 ms", async () => {
  const { request, scope, storePath, updatedAt } = createStore();
  const victimKey = "agent:main:busy-victim";
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, victimKey, { sessionId: "victim", updatedAt: updatedAt - 2_000 });
  }, scope);
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  const counts = { committed: 0, rejected: 0, writes: 0 };
  dispatch.mockImplementation(async (params) => {
    for (let tick = 0; tick < 12; tick += 1) {
      vi.setSystemTime(Date.now() + 100);
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, sessionKey, {
          sessionId: "age-kick",
          updatedAt: Date.now(),
          label: `write-${++counts.writes}`,
        });
      }, scope);
      kickSessionEntryMaintenanceAfterWrite(request);
    }
    try {
      const result = await run(params);
      if (result.kind === "maintenance-plan") {
        counts.committed += 1;
      }
      return result;
    } catch (error) {
      counts.rejected += 1;
      throw error;
    }
  });
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  console.info("busy maintenance owner", counts);
  expect(counts.committed).toBe(1);
  expect(counts.rejected).toBe(0);
  expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archiveReason).toBe(
    "age-retention",
  );
});

it("commits automatic maintenance after 20 sessions write during preparation", async ({
  signal,
}) => {
  const { request, scope, storePath, updatedAt, archived } = createStore(86_400_000, sessionKey, {
    workerMaintenance: true,
  });
  const victimKey = "agent:main:prepared-victim";
  const writers = Array.from({ length: 20 }, (_, index) => `agent:main:writer-${index}`);
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, victimKey, {
      sessionId: "victim",
      updatedAt: updatedAt - 172_800_000,
    });
    for (const key of writers) {
      writeSessionEntry(owner, key, { sessionId: key, updatedAt });
    }
  }, scope);
  let preparations = 0;
  observeSessionMaintenancePlanningWorker({
    async afterPrepare() {
      preparations += 1;
      if (preparations !== 1) {
        return;
      }
      await Promise.all(
        writers.map(async (key) => {
          await patchSessionEntryCore({ storePath, sessionKey: key }, () => ({ label: "busy" }), {
            skipMaintenance: true,
          });
          kickSessionEntryMaintenanceAfterWrite({ ...request, activeSessionKey: key });
        }),
      );
    },
  });
  kickSessionEntryMaintenanceAfterWrite(request);
  await withinTest(archived, signal);
  expect(preparations).toBe(1);
  expect(countPlanningPasses()).toBe(1);
  expect(loadSessionEntry({ storePath, sessionKey: victimKey })?.archiveReason).toBe(
    "age-retention",
  );
  for (const key of writers) {
    expect(loadSessionEntry({ storePath, sessionKey: key })?.label).toBe("busy");
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
  }
});

it.for(["removed", "unrelated", "victim"] as const)(
  "rechecks %s protection at the automatic maintenance commit",
  async (change, { signal }) => {
    const { request, scope, storePath, updatedAt, archived } = createStore(86_400_000, sessionKey, {
      workerMaintenance: true,
    });
    const victimKey = "agent:main:commit-victim";
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, victimKey, {
        sessionId: "victim",
        updatedAt: updatedAt - 172_800_000,
      });
    }, scope);
    let keys = change === "removed" ? [sessionKey] : [];
    const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
      capture: () => keys,
      dispose() {},
    }));
    let commits = 0;
    observeSessionMaintenancePlanningWorker({
      beforeAdmission(admission) {
        if (admission.stage === "commit") {
          commits += 1;
          keys = change === "removed" ? [] : [change === "victim" ? victimKey : sessionKey];
        }
      },
    });
    const rejected = createDeferred();
    const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
    const run = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (params) => {
      try {
        return await run(params);
      } catch (error) {
        rejected.resolve();
        throw error;
      }
    });
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      if (change === "victim") {
        await withinTest(rejected.promise, signal);
        await yieldToEventLoop();
        expect(loadSessionEntry({ storePath, sessionKey: victimKey })?.archivedAt).toBeUndefined();
        await vi.advanceTimersByTimeAsync(999);
      } else {
        await withinTest(archived, signal);
        expect(loadSessionEntry({ storePath, sessionKey: victimKey })?.archiveReason).toBe(
          "age-retention",
        );
      }
      expect(commits).toBe(1);
      expect(countPlanningPasses()).toBe(1);
    } finally {
      await agentDatabase.closeOpenClawAgentDatabasesAsync();
      unregister();
    }
  },
);

it("finishes a running pass with its captured policy when configuration changes", async ({
  signal,
}) => {
  const { request, scope, storePath, updatedAt, archived } = createStore();
  const victimKey = "agent:main:replan-victim";
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, victimKey, { sessionId: "victim", updatedAt: updatedAt - 2_000 });
  }, scope);
  const logger = logging.getChildLogger({ subsystem: "session-sqlite" });
  vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
  const warn = vi.spyOn(logger, "warn");
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  let changed = false;

  dispatch.mockImplementation((params) => {
    if (
      params.plan.kind === "maintenance-plan" &&
      params.plan.input.preservation !== null &&
      !changed
    ) {
      changed = true;
      request.maintenanceConfig.pruneAfterMs = 60_000;
    }
    return run(params);
  });
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(changed).toBe(true);
  expect(countPlanningPasses()).toBe(1);
  await withinTest(archived, signal);
  expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archiveReason).toBe(
    "age-retention",
  );
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  {
    name: "dashboard activity",
    key: "agent:main:dashboard:age-kick",
    pruneAfterMs: 5_000,
    archiveDashboardAfterMs: 1_000,
    preserveRecentMs: null,
    waitMs: 1_000,
    archiveReason: "stale-dashboard",
  },
  {
    name: "recent activity protection",
    key: sessionKey,
    pruneAfterMs: 1_000,
    archiveDashboardAfterMs: null,
    preserveRecentMs: 2_000,
    waitMs: 2_000,
    archiveReason: "age-retention",
  },
])("reschedules the next age crossing after $name delays maintenance", async (scenario) => {
  const { request, scope, storePath, updatedAt } = createStore(scenario.pruneAfterMs, scenario.key);
  request.maintenanceConfig.archiveDashboardAfterMs = scenario.archiveDashboardAfterMs;
  request.maintenanceConfig.preserveRecentMs = scenario.preserveRecentMs;
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, scenario.key, {
      sessionId: "age-kick",
      updatedAt: updatedAt - 1_000,
      lastActivityAt: updatedAt,
    });
  }, scope);
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  const target = { sessionKey: scenario.key, storePath };
  await vi.advanceTimersByTimeAsync(scenario.waitMs);
  expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await yieldToEventLoop();
  expect(loadSessionEntry(target)).toMatchObject({ archiveReason: scenario.archiveReason });
});

it.each(["acknowledged write"] as const)(
  "cancels a pending %s pass when its database closes without maintaining a reopened handle",
  async (pending) => {
    const { database, request, scope, storePath, updatedAt } = createStore();
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    if (pending === "acknowledged write") {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, sessionKey, { sessionId: "age-kick", updatedAt, label: "batch" });
      }, scope);
      kickSessionEntryMaintenanceAfterWrite(request);
    }
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const reopened = openOpenClawAgentDatabase(scope);
    expect(reopened).not.toBe(database);

    await vi.advanceTimersByTimeAsync(1_001);
    await yieldToEventLoop();
    expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
  },
);

it.each(["restore", "import", "insert", "policy"] as const)(
  "honors an earlier due time after %s updates the retained maintenance deadline",
  async (operation) => {
    const { request, scope, storePath, updatedAt } = createStore();
    const oldKey = "agent:main:historical";
    const entry = { sessionId: "historical", updatedAt: updatedAt - 500 };
    if (operation === "restore" || operation === "policy") {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(
          owner,
          oldKey,
          operation === "restore" ? { ...entry, archivedAt: updatedAt } : { ...entry, updatedAt },
        );
      }, scope);
    }
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();

    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, sessionKey, { sessionId: "age-kick", updatedAt, label: "batch" });
    }, scope);
    kickSessionEntryMaintenanceAfterWrite(request);
    if (operation === "policy") {
      request.maintenanceConfig.pruneAfterMs = 500;
    } else if (operation === "import") {
      await importSqliteSessionRowsBatch([{ storePath, sessionKey: oldKey, entry }]);
    } else {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, oldKey, entry);
      }, scope);
    }
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    await vi.advanceTimersByTimeAsync(500);
    expect(loadSessionEntry({ storePath, sessionKey: oldKey })?.archivedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await yieldToEventLoop();
    expect(loadSessionEntry({ storePath, sessionKey: oldKey })).toMatchObject({
      archiveReason: "age-retention",
    });
  },
);
