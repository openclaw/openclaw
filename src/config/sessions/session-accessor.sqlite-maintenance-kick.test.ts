import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import * as logging from "../../logging/logger.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawAgentDatabasesForTest,
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

function createStore(pruneAfterMs = 1_000, { workerMaintenance = false } = {}) {
  const store = createSessionMaintenanceKickStore({
    storePath: path.join(tempDirs.make("session-maintenance-kick-"), "agent.sqlite"),
    key: sessionKey,
    pruneAfterMs,
    workerMaintenance,
    maintenanceScopes,
  });
  const write = (...entries: [string, Partial<Parameters<typeof writeSessionEntry>[2]>][]) =>
    runOpenClawAgentWriteTransaction((owner) => {
      for (const [entryKey, fields] of entries) {
        writeSessionEntry(owner, entryKey, {
          sessionId: entryKey === sessionKey ? "age-kick" : entryKey,
          updatedAt: store.updatedAt,
          ...fields,
        });
      }
    }, store.scope);
  const read = (entryKey = sessionKey) =>
    loadSessionEntry({ storePath: store.storePath, sessionKey: entryKey });
  const expectArchive = (entryKey = sessionKey, reason?: string) => {
    if (reason === undefined) {
      expect(read(entryKey)?.archivedAt).toBeUndefined();
    } else {
      expect(read(entryKey)?.archiveReason).toBe(reason);
    }
  };
  return { ...store, write, read, expectArchive };
}

const createWorkerStore = () => createStore(86_400_000, { workerMaintenance: true });

function observeWarnings() {
  const logger = logging.getChildLogger({ subsystem: "session-sqlite" });
  vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
  return vi.spyOn(logger, "warn");
}

it("joins automatic worker maintenance while Doctor drainage waits on other work", async () => {
  const { request } = createStore(1_000, { workerMaintenance: true });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess() {},
  });
  const blocked = createDeferred();
  void maintenance.track(blocked.promise);
  const warn = vi.spyOn(logging.getChildLogger({ subsystem: "session-sqlite" }), "warn");
  maintenance.run(() => kickSessionEntryMaintenanceAfterWrite(request));
  const closing = maintenance.close();
  try {
    await yieldToEventLoop();
    blocked.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(reclamationRun.runSqliteSessionReclamation).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    blocked.resolve();
    await Promise.allSettled([closing]);
  }
});

it("resumes idle capacity maintenance when acquired work releases without another write", async ({
  signal,
}) => {
  const { request, storePath, archived, planned, write, expectArchive } = createWorkerStore();
  request.maintenanceConfig.maxEntries = 1;
  const protectedKey = "agent:main:admission-locked-capacity-owner";
  const partialKey = "agent:main:admission-partial-capacity-victim";
  vi.useRealTimers();
  write(
    [protectedKey, { sessionId: "admission-locked-capacity-owner", modelSelectionLocked: true }],
    [partialKey, { sessionId: "admission-partial-capacity-victim" }],
  );
  const admission = await beginSessionEffect({
    scope: storePath,
    identities: [sessionKey, "age-kick"],
  });
  const partialAdmission = await beginSessionEffect({
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
    expectArchive(partialKey);
    const partialSettled = observeNextPeriodicMaintenance(
      (delay) => delay >= ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS / 2,
    );
    partialAdmission.release();
    await withinTest(archived, signal);
    await partialSettled(signal);
    expectArchive(partialKey, "active-session-cap");
    expectArchive();
    admission.release();
    await withinTest(remainingArchived, signal);
    expectArchive(sessionKey, "active-session-cap");
    expectArchive(protectedKey);
  } finally {
    partialAdmission.release();
    admission.release();
  }
});

it.for(["young", "capacity", "expired"] as const)(
  "uses delivery settlement facts to schedule a %s store",
  async (scenario, { signal }) => {
    const { request, storePath, updatedAt, archived, planned, write, expectArchive } =
      createWorkerStore();
    request.maintenanceConfig.maxEntries = scenario === "capacity" ? 1 : 10;
    request.maintenanceConfig.archiveDashboardAfterMs = scenario === "expired" ? 1_000 : null;
    const target = {
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:delivery-maintenance-victim",
      sessionId: "delivery-maintenance-victim",
    };
    write(
      [sessionKey, { modelSelectionLocked: true }],
      [
        target.sessionKey,
        {
          sessionId: target.sessionId,
          updatedAt: scenario === "expired" ? updatedAt - 2_000 : updatedAt,
          pendingFinalDelivery: {
            kind: "transport-only",
            createdAt: updatedAt,
            intentId: "maintenance-intent",
            deliveries: [{ id: "maintenance-delivery", state: "prepared" }],
          },
        },
      ],
    );
    const manager = await SessionManager.openAsync(target, path.dirname(storePath));
    const message = {
      role: "user" as const,
      content: "Synthetic input delivery-maintenance",
      timestamp: 1,
      idempotencyKey: "delivery-maintenance:user",
    };
    await manager.appendMessageAsync(message);
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(planned, signal);
    await yieldToEventLoop();
    const protectedPasses = countPlanningPasses();
    expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeDefined();
    expect(loadSessionEntry(target)?.archivedAt).toBeUndefined();
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
        { clearAfterSettled: true as const, preserveActivity: true },
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
      await withinTest(archived, signal);
      expect(loadSessionEntry(target)?.archiveReason).toBe(
        scenario === "capacity" ? "active-session-cap" : "stale-dashboard",
      );
    }
    expectArchive();
    expect((await loadTranscriptEvents(target)).at(-1)).toMatchObject({ message });
  },
);

it.for(["activity", "young-activity", "insert", "unlock", "remove"] as const)(
  "settles a consumed worker plan after %s during result delivery",
  async (change, { signal }) => {
    const { request, scope, updatedAt, archived, write, read } = createWorkerStore();
    request.maintenanceConfig.maxEntries = change === "young-activity" ? 100 : 1;
    const protectedKey = "agent:main:durable-worker-protected";
    const insertedKey = "agent:main:durable-worker-inserted";
    write(
      [sessionKey, { sessionId: sessionKey, modelSelectionLocked: true }],
      [protectedKey, { sessionId: protectedKey, modelSelectionLocked: true }],
    );
    const writeActivity = () => {
      write([
        sessionKey,
        {
          sessionId: sessionKey,
          updatedAt: Date.now(),
          modelSelectionLocked: true,
          label: "ordinary activity",
        },
      ]);
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
        expect(result.value.durableNoCandidates === true).toBe(change !== "young-activity");
        delivered = true;
        if (change === "activity" || change === "young-activity") {
          writeActivity();
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
    if (change !== "activity" && change !== "young-activity") {
      await vi.advanceTimersByTimeAsync(1_001);
      await withinTest(nextPass.promise, signal);
      if (change === "insert" || change === "unlock") {
        await withinTest(archived, signal);
        expect(read(change === "insert" ? insertedKey : protectedKey)?.archiveReason).toBe(
          "active-session-cap",
        );
      } else if (change === "remove") {
        expect(read(protectedKey)).toBeUndefined();
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
  const { request, write, expectArchive } = createStore(86_400_000);
  request.maintenanceConfig.maxEntries = 2;
  const victimKey = "agent:main:eligible-before-overflow";
  write(
    [sessionKey, { modelSelectionLocked: true }],
    [victimKey, { sessionId: "eligible-before-overflow" }],
  );
  const settled = observeNextPeriodicMaintenance();
  kickSessionEntryMaintenanceAfterWrite(request);
  await settled(signal);
  expectArchive(victimKey);
  write([
    "agent:main:protected-overflow",
    { sessionId: "protected-overflow", modelSelectionLocked: true },
  ]);
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  await vi.advanceTimersByTimeAsync(1_001);
  expectArchive(victimKey, "active-session-cap");
});

it("keeps a pending maintenance retry bounded while ordinary writes continue", async ({
  signal,
}) => {
  const { request, write, expectArchive } = createStore(86_400_000);
  request.maintenanceConfig.maxEntries = 1;
  const victimKey = "agent:main:quiet-retry-victim";
  write(
    [sessionKey, { modelSelectionLocked: true }],
    [victimKey, { sessionId: "quiet-retry-victim" }],
  );
  let keys = [victimKey];
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: () => keys,
    dispose() {},
  }));
  const writeActivity = (label: string) => {
    write([sessionKey, { updatedAt: Date.now(), modelSelectionLocked: true, label }]);
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
    expectArchive(victimKey, "active-session-cap");
    expectArchive();
  } finally {
    await agentDatabase.closeOpenClawAgentDatabasesAsync();
    unregister();
  }
});

it("stops automatic maintenance when Gateway drain starts before immediate", async () => {
  const { request } = createStore();
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  kickSessionEntryMaintenanceAfterWrite(request);
  markGatewayRestartDraining("stop (SIGTERM)");
  await yieldToEventLoop();
  expect(dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS + 1);
  expect(dispatch).not.toHaveBeenCalled();
});

it("retires automatic maintenance when database admission is refused before its periodic pass", async () => {
  const { request } = createStore();
  const warn = vi.spyOn(logging.getChildLogger({ subsystem: "session-sqlite" }), "warn");
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(dispatch.mock.calls.filter(([{ plan }]) => plan.kind === "maintenance-plan")).toHaveLength(
    1,
  );
  dispatch.mockClear();
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
});

it.each([
  ["a drain-refused commit", false],
  ["an independent failure", true],
] as const)("classifies %s that settles during Gateway drain", async (outcome, warns) => {
  const { request } = createStore();
  const warn = observeWarnings();
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
  const failure = expect.objectContaining({ error: "disk I/O error" });
  if (warns) {
    expect(warn).toHaveBeenCalledWith("SQLite automatic session maintenance failed", failure);
  } else {
    expect(warn).not.toHaveBeenCalled();
  }
});

it("resumes automatic maintenance after Gateway work admission resets", async ({ signal }) => {
  const { archived, expectArchive, request } = createStore();
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
  expectArchive(sessionKey, "age-retention");
});

it("keeps periodic retry cadence after planning fails with retained age facts", async ({
  signal,
}) => {
  const { request } = createStore();
  const firstDeadline = observeNextPeriodicMaintenance(1_001);
  kickSessionEntryMaintenanceAfterWrite(request);
  await firstDeadline(signal);
  const warn = observeWarnings();
  vi.mocked(reclamationRun.runSqliteSessionReclamation).mockRejectedValue(
    new Error("disk I/O error"),
  );
  await vi.advanceTimersByTimeAsync(1_001);
  await yieldToEventLoop();
  expect(countPlanningPasses()).toBe(2);
  await vi.advanceTimersByTimeAsync(100);
  await yieldToEventLoop();
  expect(countPlanningPasses()).toBe(2);
  expect(warn).toHaveBeenCalledTimes(1);
});

it("does not dispatch maintenance in warn mode", async () => {
  const { request, expectArchive } = createStore();
  request.maintenanceConfig.mode = "warn";
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(reclamationRun.runSqliteSessionReclamation).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
  expectArchive();
});

it("commits automatic maintenance after 20 sessions write during preparation", async ({
  signal,
}) => {
  const { request, storePath, updatedAt, archived, read, write, expectArchive } =
    createWorkerStore();
  const victimKey = "agent:main:prepared-victim";
  const writers = Array.from({ length: 20 }, (_, index) => `agent:main:writer-${index}`);
  write(
    [victimKey, { sessionId: "victim", updatedAt: updatedAt - 172_800_000 }],
    ...writers.map((key): Parameters<typeof write>[number] => [key, {}]),
  );
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
  expectArchive(victimKey, "age-retention");
  for (const key of writers) {
    expect(read(key)?.label).toBe("busy");
    expectArchive(key);
  }
});

it("allows unrelated provider protection added at the automatic maintenance commit", async ({
  signal,
}) => {
  const { updatedAt, archived, write, expectArchive, request } = createWorkerStore();
  const victimKey = "agent:main:commit-victim";
  write([victimKey, { sessionId: "victim", updatedAt: updatedAt - 172_800_000 }]);
  let keys: string[] = [];
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: () => keys,
    dispose() {},
  }));
  observeSessionMaintenancePlanningWorker({
    beforeAdmission(admission) {
      if (admission.stage === "commit") {
        keys = [sessionKey];
      }
    },
  });
  try {
    kickSessionEntryMaintenanceAfterWrite(request);
    await withinTest(archived, signal);
    expectArchive(victimKey, "age-retention");
  } finally {
    await agentDatabase.closeOpenClawAgentDatabasesAsync();
    unregister();
  }
});

it("finishes a running pass with its captured policy when configuration changes", async ({
  signal,
}) => {
  const { request, updatedAt, archived, write, expectArchive } = createStore();
  const victimKey = "agent:main:replan-victim";
  write([victimKey, { sessionId: "victim", updatedAt: updatedAt - 2_000 }]);
  const warn = observeWarnings();
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
  expectArchive(victimKey, "age-retention");
  expect(warn).not.toHaveBeenCalled();
});

it.each(["restore", "import", "insert", "policy"] as const)(
  "honors an earlier due time after %s updates the retained maintenance deadline",
  async (operation) => {
    const { request, storePath, updatedAt, write, read, expectArchive } = createStore();
    const oldKey = "agent:main:historical";
    const entry = { sessionId: "historical", updatedAt: updatedAt - 500 };
    if (operation === "restore" || operation === "policy") {
      write([
        oldKey,
        operation === "restore" ? { ...entry, archivedAt: updatedAt } : { ...entry, updatedAt },
      ]);
    }
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();

    write([sessionKey, { label: "batch" }]);
    kickSessionEntryMaintenanceAfterWrite(request);
    if (operation === "policy") {
      request.maintenanceConfig.pruneAfterMs = 500;
    } else if (operation === "import") {
      await importSqliteSessionRowsBatch([{ storePath, sessionKey: oldKey, entry }]);
    } else {
      write([oldKey, entry]);
    }
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    await vi.advanceTimersByTimeAsync(500);
    expectArchive(oldKey);
    await vi.advanceTimersByTimeAsync(1);
    await yieldToEventLoop();
    expect(read(oldKey)).toMatchObject({
      archiveReason: "age-retention",
    });
  },
);
