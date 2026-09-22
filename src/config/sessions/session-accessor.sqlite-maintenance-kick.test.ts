import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { loadSessionEntry } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
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
    const plans = vi.spyOn(maintenance, "applySessionEntryMaintenance");
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
  vi.spyOn(maintenance, "applySessionEntryMaintenance").mockImplementationOnce(() => {
    throw new Error("temporary maintenance failure");
  });
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
