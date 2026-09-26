import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as logging from "../../logging/logger.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { loadSessionEntry } from "./session-accessor.js";
import { readSessionEntryCount, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:age-kick";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createStore(pruneAfterMs = 1_000, key = sessionKey) {
  // Keep the fake clock in this process without replacing admission or commit ownership.
  const runReclamation = reclamation.runSqliteSessionReclamation;
  vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation((params) =>
    runReclamation({ ...params, forceInProcess: true }),
  );
  const storePath = path.join(tempDirs.make("session-maintenance-kick-"), "agent.sqlite");
  const scope = { agentId: "main", path: storePath };
  const database = openOpenClawAgentDatabase(scope);
  const updatedAt = Date.now();
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, key, { sessionId: "age-kick", updatedAt });
  }, scope);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
  return { database, request, scope, storePath, updatedAt };
}

it("captures warn-mode age facts without constructing or dispatching reclamation", async () => {
  const { request, storePath } = createStore();
  request.maintenanceConfig.mode = "warn";
  const capture = vi.spyOn(ageFacts, "captureSessionEntryMaintenanceAgeFact");
  const plans = vi.spyOn(reclamation, "createSessionMaintenancePlanningOperation");
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(plans).not.toHaveBeenCalled();
  expect(reclamation.runSqliteSessionReclamation).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
  expect(capture).toHaveBeenCalledTimes(1);
});

it("commits an automatic plan while unrelated writes arrive every 100 ms", async () => {
  const { request, scope, storePath, updatedAt } = createStore();
  const victimKey = "agent:main:busy-victim";
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, victimKey, { sessionId: "victim", updatedAt: updatedAt - 2_000 });
  }, scope);
  const dispatch = vi.mocked(reclamation.runSqliteSessionReclamation);
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

it.each([1, 3])(
  "replans protection conflicts without write quiet, bounded at three attempts (%s)",
  async (conflicts) => {
    const { request, scope, storePath, updatedAt } = createStore();
    const victimKey = "agent:main:replan-victim";
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, victimKey, { sessionId: "victim", updatedAt: updatedAt - 2_000 });
    }, scope);
    const logger = logging.getChildLogger({ subsystem: "session-sqlite" });
    vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
    const warn = vi.spyOn(logger, "warn");
    const plans = vi.spyOn(reclamation, "createSessionMaintenancePlanningOperation");
    const dispatch = vi.mocked(reclamation.runSqliteSessionReclamation);
    const run = dispatch.getMockImplementation()!;
    let rejections = 0;
    let protectedKey = "agent:main:unrelated-protection-0";
    const unregister = registerSessionMaintenancePreserveKeysProvider(() => [protectedKey]);
    dispatch.mockImplementation((params) => {
      if (
        params.plan.kind === "maintenance-plan" &&
        params.plan.input.preservation !== null &&
        rejections < conflicts
      ) {
        protectedKey = `agent:main:unrelated-protection-${++rejections}`;
      }
      return run(params);
    });
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      await yieldToEventLoop();
      expect(rejections).toBe(conflicts);
      expect(plans).toHaveBeenCalledTimes(conflicts === 1 ? 2 : 3);
      if (conflicts === 3) {
        expect(warn).toHaveBeenCalledWith(
          "SQLite automatic session maintenance paused after repeated input changes",
          expect.objectContaining({ rejections: 3, error: expect.any(Error) }),
        );
        expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archivedAt).toBeUndefined();
        await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
        expect(plans).toHaveBeenCalledTimes(3);
        kickSessionEntryMaintenanceAfterWrite(request);
        await vi.advanceTimersByTimeAsync(1_000);
        await yieldToEventLoop();
      }
      expect(loadSessionEntry({ sessionKey: victimKey, storePath })?.archiveReason).toBe(
        "age-retention",
      );
    } finally {
      unregister();
    }
  },
);

it("archives an entry at its age boundary without another write", async () => {
  const { request, storePath } = createStore();
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();

  await vi.advanceTimersByTimeAsync(1_000);
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await yieldToEventLoop();
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

it("cancels a pending age pass when its database closes without maintaining a reopened handle", async () => {
  const { database, request, scope, storePath } = createStore();
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  closeOpenClawAgentDatabaseByPath(database.path);
  const reopened = openOpenClawAgentDatabase(scope);
  expect(reopened).not.toBe(database);

  await vi.advanceTimersByTimeAsync(1_001);
  await yieldToEventLoop();
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
});

it.each(["restore", "import", "insert"] as const)(
  "honors the earlier due time of a historical %s after warming the age fact",
  async (operation) => {
    const { request, scope, storePath, updatedAt } = createStore();
    const oldKey = "agent:main:historical";
    const entry = { sessionId: "historical", updatedAt: updatedAt - 500 };
    if (operation === "restore") {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, oldKey, { ...entry, archivedAt: updatedAt });
      }, scope);
    }
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();

    if (operation === "import") {
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

it("rechecks foreign backdates at 30 minutes even when ordinary writes keep kicking", async () => {
  const { database, request, scope, storePath, updatedAt } = createStore(60 * 60 * 1_000);
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
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await yieldToEventLoop();
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
    const release = registerSessionMaintenancePreserveKeysProvider(() => [sessionKey]);
    const plans = vi.spyOn(reclamation, "createSessionMaintenancePlanningOperation");
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      await yieldToEventLoop();
      expect(plans).toHaveBeenCalledTimes(1);
      vi.setSystemTime(updatedAt - clockRollbackMs);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 - 1);
      expect(plans).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await yieldToEventLoop();
      expect(plans).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(plans).toHaveBeenCalledTimes(2);
      expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();

      release();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      await yieldToEventLoop();
      expect(plans).toHaveBeenCalledTimes(3);
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        archiveReason: "age-retention",
      });
    } finally {
      release();
    }
  },
);

it("retries a transient maintenance failure on its next periodic pass", async () => {
  const { request, storePath } = createStore();
  vi.mocked(reclamation.runSqliteSessionReclamation).mockRejectedValueOnce(
    new Error("temporary maintenance failure"),
  );
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();

  await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
  await yieldToEventLoop();
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    archiveReason: "age-retention",
  });
});

it("backs off admission failures after the periodic deadline expires", async () => {
  const { request } = createStore(60 * 60 * 1_000);
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  const writes = vi
    .spyOn(agentDatabase, "runOpenClawAgentWriteTransaction")
    .mockImplementation(() => {
      throw new Error("database admission unavailable");
    });

  await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 1);
  await yieldToEventLoop();
  expect(writes).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 - 2);
  expect(writes).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await yieldToEventLoop();
  expect(writes).toHaveBeenCalledTimes(2);
});

it.each(
  (["backdate", "insert"] as const).flatMap((mutation) =>
    (["after preparation", "after no-op resolution"] as const).map((boundary) => ({
      mutation,
      boundary,
    })),
  ),
)("replans a warm no-op after an owned $mutation $boundary", async ({ mutation, boundary }) => {
  const { database, request, scope, storePath, updatedAt } = createStore();
  request.maintenanceConfig.maxEntries = 2;
  const victimKey = "agent:main:warm-no-op-victim";
  const insertedKey = "agent:main:warm-no-op-inserted";
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, victimKey, { sessionId: "victim", updatedAt });
  }, scope);
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(
    ageFacts.readSessionEntryMaintenanceAgeFact(database.db, request.maintenanceConfig)?.next.at,
  ).toBeGreaterThan(Date.now());

  let changed = false;
  const mutate = () => {
    // Neither synchronous writer kicks maintenance. A fresh insert must invalidate
    // the count decision even when it cannot bring the next age boundary forward.
    if (mutation === "insert") {
      changed = ensureSessionEntrySync(
        { sessionKey: insertedKey, storePath },
        { sessionId: "inserted", updatedAt: updatedAt + 1 },
      );
    } else {
      runOpenClawAgentWriteTransaction((owner) => {
        writeSessionEntry(owner, victimKey, { sessionId: "victim", updatedAt: updatedAt - 2_000 });
      }, scope);
      changed = true;
    }
  };
  if (boundary === "after preparation") {
    const capture = ageFacts.captureSessionEntryMaintenanceAgeFact;
    vi.spyOn(ageFacts, "captureSessionEntryMaintenanceAgeFact").mockImplementationOnce(
      (...args) => {
        const result = capture(...args);
        queueMicrotask(mutate);
        return result;
      },
    );
  } else {
    const dispatch = vi.mocked(reclamation.runSqliteSessionReclamation);
    const run = dispatch.getMockImplementation()!;
    dispatch.mockImplementationOnce(async (params) => {
      const result = await run(params);
      mutate();
      return result;
    });
  }

  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(changed).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  await yieldToEventLoop();
  expect(loadSessionEntry({ sessionKey: victimKey, storePath })).toMatchObject({
    archivedAt: expect.any(Number),
    archiveReason: mutation === "insert" ? "active-session-cap" : "age-retention",
  });
  expect(readSessionEntryCount(database, { includeArchived: false })).toBe(
    mutation === "insert" ? 2 : 1,
  );
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
  if (mutation === "insert") {
    expect(loadSessionEntry({ sessionKey: insertedKey, storePath })).toMatchObject({
      sessionId: "inserted",
      updatedAt: updatedAt + 1,
    });
    expect(loadSessionEntry({ sessionKey: insertedKey, storePath })?.archivedAt).toBeUndefined();
  }
});

it("enforces a newly crossed cap while the parent age fact is still warm", async () => {
  const { database, request, scope, storePath, updatedAt } = createStore();
  request.maintenanceConfig.maxEntries = 2;
  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  const initial = ageFacts.readSessionEntryMaintenanceAgeFact(
    database.db,
    request.maintenanceConfig,
  );
  expect(initial).toBeDefined();
  const olderKey = "agent:main:cap-older";
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, olderKey, { sessionId: "older", updatedAt: updatedAt - 1 });
    writeSessionEntry(owner, "agent:main:cap-newer", { sessionId: "newer", updatedAt });
  }, scope);
  expect(readSessionEntryCount(database, { includeArchived: false })).toBe(3);
  expect(
    ageFacts.readSessionEntryMaintenanceAgeFact(database.db, request.maintenanceConfig)?.next.at,
  ).toBeGreaterThan(Date.now());

  kickSessionEntryMaintenanceAfterWrite(request);
  await yieldToEventLoop();
  expect(readSessionEntryCount(database, { includeArchived: false })).toBe(2);
  expect(loadSessionEntry({ sessionKey: olderKey, storePath })).toMatchObject({
    archiveReason: "active-session-cap",
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
});

it.runIf(process.platform !== "win32").each(["before preparation", "after preparation"] as const)(
  "does not accept a warm no-op after the database path is replaced %s",
  async (when) => {
    const { database, request, storePath } = createStore();
    kickSessionEntryMaintenanceAfterWrite(request);
    await yieldToEventLoop();
    expect(
      ageFacts.readSessionEntryMaintenanceAgeFact(database.db, request.maintenanceConfig),
    ).toBeDefined();
    const heldPath = `${database.path}.held`;
    const replacementPath = `${database.path}.replacement`;
    writeFileSync(replacementPath, "synthetic replacement; never opened as SQLite");
    let replaced = false;
    const replacePath = () => {
      renameSync(database.path, heldPath);
      renameSync(replacementPath, database.path);
      replaced = true;
    };
    const restorePath = () => {
      if (replaced) {
        renameSync(database.path, replacementPath);
        renameSync(heldPath, database.path);
        replaced = false;
      }
    };
    const dispatch = vi.mocked(reclamation.runSqliteSessionReclamation);
    const run = dispatch.getMockImplementation();
    if (!run) {
      throw new Error("Expected the fixture's in-process reclamation adapter");
    }
    dispatch.mockClear();
    dispatch.mockImplementation((params) => {
      // A stale path must reach ordinary reclamation validation, not settle as a
      // successful no-op. Restore it before exercising the real fixture operation.
      restorePath();
      return run(params);
    });
    if (when === "before preparation") {
      replacePath();
    } else {
      const capture = ageFacts.captureSessionEntryMaintenanceAgeFact;
      vi.spyOn(ageFacts, "captureSessionEntryMaintenanceAgeFact").mockImplementationOnce(
        (...args) => {
          const result = capture(...args);
          queueMicrotask(replacePath);
          return result;
        },
      );
    }
    try {
      kickSessionEntryMaintenanceAfterWrite(request);
      await yieldToEventLoop();
      if (when === "after preparation") {
        await vi.advanceTimersByTimeAsync(1_000);
        await yieldToEventLoop();
      }
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(replaced).toBe(false);
      expect(loadSessionEntry({ sessionKey, storePath })?.archivedAt).toBeUndefined();
    } finally {
      restorePath();
    }
  },
);
