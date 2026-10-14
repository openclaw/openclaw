import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as logging from "../../logging/logger.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import * as databaseMaintenance from "../../state/openclaw-state-db-async-lifecycle.js";
import { loadSessionEntry } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenanceKick from "./session-accessor.sqlite-maintenance-kick.js";
import { observeSessionMaintenancePlanningWorker } from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

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
  // Policy tests keep the fake clock in the native maintenance owner's process.
  const maintenance = workerMaintenance
    ? undefined
    : createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent() {},
        assertDatabaseAccess() {},
      });
  if (maintenance) {
    maintenanceScopes.push(maintenance);
    const kick = maintenanceKick.kickSessionEntryMaintenanceAfterWrite;
    vi.spyOn(maintenanceKick, "kickSessionEntryMaintenanceAfterWrite").mockImplementation(
      (request) => maintenance.run(() => kick(request)),
    );
    const captureResource = databaseMaintenance.captureOpenClawDatabaseMaintenanceResource;
    vi.spyOn(databaseMaintenance, "captureOpenClawDatabaseMaintenanceResource").mockImplementation(
      (resource, scope) => {
        const captured = captureResource(resource, scope);
        // Keep the scheduling owner and its callbacks on the same fake-clock execution path.
        return scope === maintenance
          ? { ...captured, runWorker: <T>(operation: () => Promise<T>) => captured.run(operation) }
          : captured;
      },
    );
  }
  const runReclamation = reclamationRun.runSqliteSessionReclamation;
  const archived = createDeferred();
  vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation((params) => {
    const result = runReclamation(params);
    // Observe publication without consuming the fault probes' original rejections.
    void result.then(
      (value) => {
        if (value.kind === "maintenance-plan" && value.value.archived > 0) {
          archived.resolve();
        }
      },
      () => {},
    );
    return result;
  });
  const storePath = path.join(tempDirs.make("session-maintenance-kick-"), "agent.sqlite");
  const scope = { agentId: "main", path: storePath };
  const database = openOpenClawAgentDatabase(scope);
  const updatedAt = Date.now();
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, key, { sessionId: "age-kick", updatedAt });
  }, scope);
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(updatedAt);
  const maintenanceConfig: ResolvedSessionMaintenanceConfig = {
    ...resolveMaintenanceConfigFromInput(),
    archiveDashboardAfterMs: null,
    preserveRecentMs: null,
    pruneAfterMs,
  };
  const request = {
    activeSessionKey: key,
    archiveDirectory: path.join(path.dirname(storePath), "archives"),
    maintenanceConfig,
    scope,
    storePath,
  };
  return { database, request, scope, storePath, updatedAt, archived: archived.promise };
}

function observeNextPeriodicMaintenance(delayMs = ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS) {
  // Install after createStore opens the handles and registers their WAL timers.
  const scheduled = createDeferred();
  const setTimer = globalThis.setTimeout;
  const observer = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
    const timer = setTimer(...args);
    if (args[1] === delayMs) {
      scheduled.resolve();
    }
    return timer;
  });
  return (signal: AbortSignal) =>
    withinTest(scheduled.promise, signal).finally(() => observer.mockRestore());
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

function countPlanningPasses() {
  return new Set(
    vi
      .mocked(reclamationRun.runSqliteSessionReclamation)
      .mock.calls.map(([{ plan }]) => plan)
      .filter((plan) => plan.kind === "maintenance-plan"),
  ).size;
}

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
