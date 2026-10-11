import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
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
import { loadSessionEntry } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:age-kick";

afterEach(async () => {
  await agentDatabase.closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createStore(pruneAfterMs = 1_000, key = sessionKey) {
  // Keep the fake clock in this process without replacing admission or commit ownership.
  const runReclamation = reclamationRun.runSqliteSessionReclamation;
  const archived = createDeferred();
  vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation((params) => {
    const result = runReclamation({ ...params, forceInProcess: true });
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

it("joins an accepted maintenance timer while Doctor drainage waits on other work", async () => {
  const { request } = createStore();
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess() {},
  });
  const blocked = createDeferred();
  void maintenance.track(blocked.promise);
  maintenance.run(() => kickSessionEntryMaintenanceAfterWrite(request));
  const closing = maintenance.close();
  try {
    await yieldToEventLoop();
    blocked.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(reclamationRun.runSqliteSessionReclamation).toHaveBeenCalled();
  } finally {
    blocked.resolve();
    await Promise.allSettled([closing]);
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

it.each(["before kick", "before immediate", "before periodic", "before another kick"] as const)(
  "stops automatic maintenance when Gateway drain starts %s",
  async (when) => {
    const { request } = createStore();
    const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
    if (when !== "before kick") {
      kickSessionEntryMaintenanceAfterWrite(request);
      if (when !== "before immediate") {
        await yieldToEventLoop();
        expect(
          dispatch.mock.calls.filter(([{ plan }]) => plan.kind === "maintenance-plan"),
        ).toHaveLength(1);
        dispatch.mockClear();
      }
    }
    markGatewayRestartDraining("stop (SIGTERM)");
    if (when === "before kick" || when === "before another kick") {
      kickSessionEntryMaintenanceAfterWrite(request);
    }
    await yieldToEventLoop();
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS + 1);
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it.each(["immediate", "periodic"] as const)(
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

it.each([
  ["a drain-refused commit", false],
  ["an unrelated failure", true],
] as const)("classifies %s that settles during Gateway drain", async (outcome, warns) => {
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
});

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

it.for([
  { pruneAfterMs: 5_000, batchAtMs: 1_000, clockRollbackMs: 0 },
  { pruneAfterMs: 500, batchAtMs: 501, clockRollbackMs: 0 },
  { pruneAfterMs: 500, batchAtMs: 501, clockRollbackMs: 60_000 },
])(
  "bounds idle write batches by the earlier age deadline ($batchAtMs ms, rollback $clockRollbackMs ms)",
  async ({ pruneAfterMs, batchAtMs, clockRollbackMs }, { signal }) => {
    const { request, scope, storePath, updatedAt } = createStore(pruneAfterMs);
    const initialized = observeNextPeriodicMaintenance(pruneAfterMs + 1);
    kickSessionEntryMaintenanceAfterWrite(request);
    await initialized(signal);
    expect(countPlanningPasses()).toBe(1);
    vi.setSystemTime(updatedAt - clockRollbackMs);

    const completed = createDeferred();
    const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
    const run = dispatch.getMockImplementation()!;
    dispatch.mockImplementation((params) => {
      const result = run(params);
      void result.then((value) => {
        if (value.kind === "maintenance-plan") {
          completed.resolve();
        }
      }, completed.reject);
      return result;
    });
    const write = (label: string) => {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, sessionKey, { sessionId: "age-kick", updatedAt, label });
      }, scope);
      kickSessionEntryMaintenanceAfterWrite(request);
    };
    write("batch-start");
    for (let tick = 1; tick <= 4; tick += 1) {
      await vi.advanceTimersByTimeAsync(100);
      write(`batch-${tick}`);
      expect(countPlanningPasses()).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(batchAtMs - 401);
    expect(countPlanningPasses()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await withinTest(completed.promise, signal);
    expect(countPlanningPasses()).toBe(2);
    expect(loadSessionEntry({ sessionKey, storePath })?.label).toBe("batch-4");
  },
);

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

it("bounds empty maintenance writes while retaining the next age deadline", async ({ signal }) => {
  const { database, request, storePath, archived } = createStore();
  const execute = vi.spyOn(database.db, "exec");
  const scheduled = observeNextPeriodicMaintenance(1_001);
  kickSessionEntryMaintenanceAfterWrite(request);
  await scheduled(signal);
  const writerAdmissions = execute.mock.calls.filter(([sql]) => /^BEGIN IMMEDIATE;?$/i.test(sql));
  expect.soft(writerAdmissions.length).toBeLessThanOrEqual(2);
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();

  await vi.advanceTimersByTimeAsync(1_000);
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await withinTest(archived, signal);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    archiveReason: "age-retention",
  });
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

it.each(["age", "write-batch"] as const)(
  "cancels a pending %s pass when its database closes without maintaining a reopened handle",
  async (pending) => {
    const { database, request, scope, storePath, updatedAt } = createStore();
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    if (pending === "write-batch") {
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
  "honors an earlier due time after %s interrupts a pending write batch",
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

it("rechecks foreign backdates at 30 minutes even when ordinary writes keep kicking", async ({
  signal,
}) => {
  const { database, request, scope, storePath, updatedAt } = createStore(60 * 60 * 1_000);
  const archived = createDeferred();
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  dispatch.mockImplementation(async (params) => {
    const result = await run(params);
    if (result.kind === "maintenance-plan" && result.value.archived > 0) {
      archived.resolve();
    }
    return result;
  });
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  const writer = new DatabaseSync(database.path);
  const oldUpdatedAt = updatedAt - 2 * 60 * 60 * 1_000;
  try {
    writer
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(
        JSON.stringify({ sessionId: "age-kick", updatedAt: oldUpdatedAt }),
        oldUpdatedAt,
        sessionKey,
      );
  } finally {
    writer.close();
  }
  await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, "agent:main:other", { sessionId: "other", updatedAt: Date.now() });
  }, scope);
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  await vi.advanceTimersByTimeAsync(15 * 60 * 1_000 - 1);
  expect(
    database.db
      .prepare("SELECT archived_at FROM session_nodes WHERE session_key = ?")
      .get(sessionKey),
  ).toEqual({ archived_at: null });
  await vi.advanceTimersByTimeAsync(1);
  await withinTest(archived.promise, signal);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    archiveReason: "age-retention",
  });
});

it.each([0, 32 * 24 * 60 * 60 * 1_000])(
  "rechecks protected entries once per interval (clock rollback: %s ms)",
  async (clockRollbackMs) => {
    const { request, scope, storePath, updatedAt } = createStore();
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, sessionKey, {
        sessionId: "age-kick",
        updatedAt: updatedAt - clockRollbackMs - 2_000,
      });
    }, scope);
    const release = registerSessionMaintenancePreserveKeysProvider(async () => ({
      capture: () => [sessionKey],
      dispose() {},
    }));
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      await yieldToEventLoop();
      expect(countPlanningPasses()).toBe(1);
      vi.setSystemTime(updatedAt - clockRollbackMs);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 - 1);
      expect(countPlanningPasses()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await yieldToEventLoop();
      expect(countPlanningPasses()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(countPlanningPasses()).toBe(2);
      expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();

      release();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      await yieldToEventLoop();
      expect(countPlanningPasses()).toBe(3);
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        archiveReason: "age-retention",
      });
    } finally {
      release();
    }
  },
);

it("retries a transient maintenance failure on its next periodic pass", async ({ signal }) => {
  const { request, storePath, archived } = createStore();
  const scheduled = observeNextPeriodicMaintenance();
  vi.mocked(reclamationRun.runSqliteSessionReclamation).mockRejectedValueOnce(
    new Error("temporary maintenance failure"),
  );
  kickSessionEntryMaintenanceAfterWrite(request);
  await scheduled(signal);
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();

  await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
  await withinTest(archived, signal);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    archiveReason: "age-retention",
  });
});
