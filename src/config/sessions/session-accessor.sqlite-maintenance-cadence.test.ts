import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryReplacements,
  assignSessionOwner,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
  recordSessionParticipant,
} from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import * as candidates from "./session-accessor.sqlite-maintenance-candidates.js";
import { applySessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import * as maintenanceRuntime from "./store-maintenance-runtime.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DAY_MS = 24 * 60 * 60 * 1000;
const key = (index: number) => `agent:main:cadence-${index}`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

function createStore(entryCount: number, updatedAt = Date.now()) {
  const storePath = path.join(tempDirs.make("session-maintenance-cadence-"), "agent.sqlite");
  const options = { agentId: "main", path: storePath };
  const database = openOpenClawAgentDatabase(options);
  runOpenClawAgentWriteTransaction((owner) => {
    for (let index = 0; index < entryCount; index += 1) {
      writeSessionEntry(owner, key(index), { sessionId: `cadence-${index}`, updatedAt });
    }
  }, options);
  return { database, options, storePath };
}

async function renameEntry(storePath: string, index: number, label: string) {
  await applySessionEntryReplacements({
    storePath,
    sessionKeys: [key(index)],
    skipMaintenance: false,
    update: (entries) => ({
      result: undefined,
      replacements: entries.map(({ entry, sessionKey }) => ({
        sessionKey,
        entry: { ...entry, label },
      })),
    }),
  });
}

function writeMetadata(storePath: string, kind: "participant" | "owner", sequence: number) {
  const scope = { storePath, sessionKey: key(0) };
  return kind === "participant"
    ? recordSessionParticipant(scope, {
        identity: { type: "agent", id: "worker" },
        promptedAt: sequence,
        sessionAgentId: "main",
      })
    : assignSessionOwner(scope, {
        owner: { type: "agent", id: `worker-${sequence}` },
        assignedBy: { type: "agent", id: "main" },
        assignedAt: sequence,
      });
}

it.each(["participant", "owner"] as const)(
  "retains maintenance age facts across %s metadata writes",
  async (kind) => {
    const { database, storePath } = createStore(24);
    writeMetadata(storePath, kind, 0);
    const factReads = vi.spyOn(ageFacts, "recordSessionEntryMaintenanceAgeFact");
    // One fact uses separate indexed probes; metadata writes must not repeat any of them.
    const queries = trackSqliteStatementExecutions(
      database.db,
      ["after", "dashboards", "pending", "unexpected"],
      (sql) => {
        if (!sql.includes('as "session_started_at"') || !sql.includes('from "session_nodes"')) {
          return null;
        }
        if (sql.includes('"age_namespaces"')) {
          return "dashboards";
        }
        if (sql.includes('"session_canonical_validation_pending"')) {
          return "pending";
        }
        return sql.includes('"updated_at" > ?') ? "after" : "unexpected";
      },
    );
    const expectedProbes = { after: 1, dashboards: 1, pending: 1, unexpected: 0 };
    const expectedRows = { after: 1, dashboards: 0, pending: 0, unexpected: 0 };
    try {
      await renameEntry(storePath, 0, "warm age facts");
      expect(factReads).toHaveBeenCalledTimes(1);
      expect(queries.counts).toEqual(expectedProbes);
      expect(queries.rowCounts).toEqual(expectedRows);
      for (let sequence = 1; sequence <= 3; sequence += 1) {
        writeMetadata(storePath, kind, sequence);
        await renameEntry(storePath, 0, `renamed-${sequence}`);
      }
      expect(loadSessionEntry({ storePath, sessionKey: key(0) })).toMatchObject({
        label: "renamed-3",
      });
      if (kind === "participant") {
        expect(listSessionParticipantsReadOnly({ agentId: "main", storePath }).get(key(0))).toEqual(
          [
            {
              identity: { type: "agent", id: "worker" },
              contributionCount: 4,
              firstPromptedAt: 0,
              lastPromptedAt: 3,
            },
          ],
        );
      } else {
        expect(loadSessionEntry({ storePath, sessionKey: key(0) })?.owner).toEqual({
          actor: { type: "agent", id: "worker-3" },
          assignedBy: { type: "agent", id: "main" },
          assignedAt: 3,
        });
      }
      expect(factReads).toHaveBeenCalledTimes(1);
      expect(queries.counts).toEqual(expectedProbes);
      expect(queries.rowCounts).toEqual(expectedRows);
    } finally {
      queries.restore();
    }
  },
);

it.each([false, true])(
  "does not rescan 4,000 fresh entries across 20 writes (foreign commits: %s)",
  async (foreignCommits) => {
    const { database, storePath } = createStore(4_000);
    const writer = foreignCommits ? new DatabaseSync(database.path) : undefined;
    writer?.exec("CREATE TABLE maintenance_cadence_noise (value INTEGER)");
    const factReads = vi.spyOn(ageFacts, "recordSessionEntryMaintenanceAgeFact");
    const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
    const keyReads = vi.spyOn(candidates, "readSessionMaintenanceKeyProjection");
    const writes = 20;
    const started = performance.now();
    try {
      for (let index = 0; index < writes; index += 1) {
        writer?.prepare("INSERT INTO maintenance_cadence_noise VALUES (?)").run(index);
        await renameEntry(storePath, index, `renamed-${index}`);
      }
    } finally {
      writer?.close();
    }
    console.info(
      `maintenance cadence: ${(performance.now() - started).toFixed(2)} ms / ${writes} writes; ` +
        `foreign commits=${foreignCommits}; fact scans=${factReads.mock.calls.length}; ` +
        `age reads=${ageReads.mock.calls.length}; key reads=${keyReads.mock.calls.length}`,
    );
    for (let index = 0; index < writes; index += 1) {
      expect(loadSessionEntry({ storePath, sessionKey: key(index) })?.label).toBe(
        `renamed-${index}`,
      );
    }
    expect(factReads).toHaveBeenCalledTimes(1);
    expect(ageReads).toHaveBeenCalledTimes(1);
    expect(keyReads).not.toHaveBeenCalled();
  },
);

it("does not rescan ordinary eight-day entries or an old protected primary session", async () => {
  const { options, storePath } = createStore(2, Date.now() - 8 * DAY_MS);
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, "agent:main:main", {
      sessionId: "primary",
      updatedAt: Date.now() - 100 * DAY_MS,
    });
  }, options);
  await renameEntry(storePath, 0, "warm age facts");
  const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
  const keyReads = vi.spyOn(candidates, "readSessionMaintenanceKeyProjection");
  for (let index = 0; index < 20; index += 1) {
    await renameEntry(storePath, index % 2, `renamed-${index}`);
  }
  expect(loadSessionEntry({ storePath, sessionKey: key(0) })).toMatchObject({
    label: "renamed-18",
  });
  expect(loadSessionEntry({ storePath, sessionKey: key(1) })).toMatchObject({
    label: "renamed-19",
  });
  expect(
    loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.archivedAt,
  ).toBeUndefined();
  expect(ageReads).not.toHaveBeenCalled();
  expect(keyReads).not.toHaveBeenCalled();
});

it("still archives entries when a write crosses the configured cap", () => {
  const { options, storePath } = createStore(2);
  const maintenanceConfig = { ...resolveMaintenanceConfigFromInput(), maxEntries: 2 };
  const maintain = (addEntry = false) =>
    runOpenClawAgentWriteTransaction((database) => {
      if (addEntry) {
        writeSessionEntry(database, key(2), { sessionId: "cadence-2", updatedAt: Date.now() });
      }
      return applySessionEntryMaintenance(database, {
        archiveDirectory: path.join(path.dirname(storePath), "archives"),
        maintenanceConfig,
        storePath,
      });
    }, options);
  expect(maintain().archived).toBe(0);
  const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
  expect(maintain(true)).toMatchObject({ archived: 1, capped: 1 });
  expect(ageReads).toHaveBeenCalledTimes(1);
  const entries = [0, 1, 2].map((index) => loadSessionEntry({ storePath, sessionKey: key(index) }));
  expect(entries.every((entry) => entry !== undefined)).toBe(true);
  expect(entries.filter((entry) => entry?.archivedAt !== undefined)).toEqual([
    expect.objectContaining({ archiveReason: "active-session-cap" }),
  ]);
});

it("forceMaintenance enforces the cap inside its ordinary-write slack", () => {
  const { options, storePath } = createStore(51);
  const maintenanceConfig = { ...resolveMaintenanceConfigFromInput(), maxEntries: 50 };
  const maintain = (forceMaintenance = false) =>
    runOpenClawAgentWriteTransaction(
      (database) =>
        applySessionEntryMaintenance(database, {
          archiveDirectory: path.join(path.dirname(storePath), "archives"),
          maintenanceConfig,
          forceMaintenance,
          storePath,
        }),
      options,
    );
  expect(maintain().archived).toBe(0);
  expect(maintain(true)).toMatchObject({ archived: 1, capped: 1 });
});

it("rechecks foreign backdates during replacements without a prior maintenance kick", async () => {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const { database, storePath } = createStore(2, now);
  await renameEntry(storePath, 0, "warm age facts through replacement");
  const writer = new DatabaseSync(database.path);
  const updatedAt = now - 31 * DAY_MS;
  try {
    writer
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(JSON.stringify({ sessionId: "cadence-1", updatedAt }), updatedAt, key(1));
  } finally {
    writer.close();
  }
  vi.setSystemTime(now + 30 * 60 * 1_000 + 1);
  await renameEntry(storePath, 0, "recheck after the periodic interval");
  expect(loadSessionEntry({ storePath, sessionKey: key(1) })).toMatchObject({
    archiveReason: "age-retention",
  });
});

it("reconsiders retention after an older timestamp is written", async () => {
  const { storePath } = createStore(2);
  await renameEntry(storePath, 0, "warm age facts");
  await applySessionEntryReplacements({
    storePath,
    sessionKeys: [key(1)],
    skipMaintenance: false,
    update: (entries) => ({
      result: undefined,
      replacements: entries.map(({ entry, sessionKey }) => ({
        sessionKey,
        entry: { ...entry, updatedAt: Date.now() - 31 * DAY_MS },
      })),
    }),
  });
  expect(loadSessionEntry({ storePath, sessionKey: key(1) })).toMatchObject({
    archiveReason: "age-retention",
  });
});

it("keeps an age boundary due when it passes between planning and recording the fact", async () => {
  const now = Date.now();
  const { storePath } = createStore(1, now);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue({
    ...resolveMaintenanceConfigFromInput(),
    pruneAfterMs: 1_000,
    archiveDashboardAfterMs: null,
    preserveRecentMs: null,
  });
  const record = ageFacts.recordSessionEntryMaintenanceAgeFact;
  vi.spyOn(ageFacts, "recordSessionEntryMaintenanceAgeFact").mockImplementationOnce((...args) => {
    vi.setSystemTime(now + 1_001);
    record(...args);
  });
  await renameEntry(storePath, 0, "boundary passed during planning");
  expect(loadSessionEntry({ storePath, sessionKey: key(0) })?.archivedAt).toBeUndefined();
  await renameEntry(storePath, 0, "reconsider the elapsed boundary");
  expect(loadSessionEntry({ storePath, sessionKey: key(0) })).toMatchObject({
    archiveReason: "age-retention",
  });
});

it("does not retain an age fact from a rolled-back archive", () => {
  const { options, storePath } = createStore(1, Date.now() - 31 * DAY_MS);
  const maintain = (database: ReturnType<typeof openOpenClawAgentDatabase>) =>
    applySessionEntryMaintenance(database, {
      archiveDirectory: path.join(path.dirname(storePath), "archives"),
      maintenanceConfig: resolveMaintenanceConfigFromInput(),
      storePath,
    });
  expect(() =>
    runOpenClawAgentWriteTransaction((database) => {
      expect(maintain(database).archived).toBe(1);
      expect(maintain(database).archived).toBe(0);
      throw new Error("roll back archive");
    }, options),
  ).toThrow("roll back archive");
  expect(loadSessionEntry({ storePath, sessionKey: key(0) })?.archivedAt).toBeUndefined();
  expect(runOpenClawAgentWriteTransaction(maintain, options).archived).toBe(1);
  expect(loadSessionEntry({ storePath, sessionKey: key(0) })).toMatchObject({
    archiveReason: "age-retention",
  });
});

it("reconsiders retention when runtime configuration shortens the age threshold", async () => {
  const { storePath } = createStore(2, Date.now() - 2 * DAY_MS);
  await renameEntry(storePath, 0, "warm age facts");
  expect(loadSessionEntry({ storePath, sessionKey: key(1) })?.archivedAt).toBeUndefined();
  vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue({
    ...resolveMaintenanceConfigFromInput(),
    pruneAfterMs: DAY_MS,
    archiveDashboardAfterMs: null,
  });
  await renameEntry(storePath, 0, "after config change");
  expect(loadSessionEntry({ storePath, sessionKey: key(1) })).toMatchObject({
    archiveReason: "age-retention",
  });
});

it("keeps age facts scoped to the store that produced them", async () => {
  const fresh = createStore(1);
  const old = createStore(1, Date.now() - 31 * DAY_MS);
  await renameEntry(fresh.storePath, 0, "fresh store");
  await renameEntry(old.storePath, 0, "old store");
  expect(loadSessionEntry({ storePath: old.storePath, sessionKey: key(0) })).toMatchObject({
    archiveReason: "age-retention",
  });
  expect(
    loadSessionEntry({ storePath: fresh.storePath, sessionKey: key(0) })?.archivedAt,
  ).toBeUndefined();
});

it("reconsiders a session unarchived without changing its timestamp", async () => {
  const { storePath } = createStore(1, Date.now() - 31 * DAY_MS);
  await renameEntry(storePath, 0, "archive old session");
  await renameEntry(storePath, 0, "warm archived-only facts");
  const archivedEntry = loadSessionEntry({ storePath, sessionKey: key(0) });
  expect(archivedEntry?.archivedAt).toEqual(expect.any(Number));
  const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
  await applySessionEntryReplacements({
    storePath,
    sessionKeys: [key(0)],
    skipMaintenance: false,
    update: (entries) => ({
      result: undefined,
      replacements: entries.map(({ entry, sessionKey }) => ({
        sessionKey,
        entry: { ...entry, archivedAt: undefined, archiveReason: undefined },
      })),
    }),
  });
  expect(ageReads).toHaveBeenCalledTimes(1);
  expect(loadSessionEntry({ storePath, sessionKey: key(0) })).toMatchObject({
    updatedAt: archivedEntry?.updatedAt,
    archivedAt: expect.any(Number),
    archiveReason: "age-retention",
  });
});

it.each([
  "shared dashboards",
  "pending dashboard alias",
  "pending namespace prefixes",
  "recent activity",
  "expired recent activity",
  "disabled ages",
] as const)("keeps exact next maintenance deadlines for %s", (scenario) => {
  const { options } = createStore(0);
  const now = Date.now();
  const maintenance: ResolvedSessionMaintenanceConfig = {
    ...resolveMaintenanceConfigFromInput(),
    pruneAfterMs: 30 * DAY_MS,
    archiveDashboardAfterMs: null,
    preserveRecentMs: null,
  };
  const result = runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, "agent:main:main", {
      sessionId: "protected-primary",
      updatedAt: now - 100 * DAY_MS,
    });
    if (scenario === "shared dashboards") {
      maintenance.archiveDashboardAfterMs = 7 * DAY_MS;
      writeSessionEntry(database, "agent:main:dashboard:first", {
        sessionId: "first-dashboard",
        updatedAt: now - 8 * DAY_MS,
        lastActivityAt: now,
      });
      writeSessionEntry(database, "agent:zeta:dashboard:second", {
        sessionId: "second-dashboard",
        updatedAt: now - 8 * DAY_MS,
        lastInteractionAt: now - DAY_MS,
      });
    } else if (scenario === "pending dashboard alias") {
      maintenance.archiveDashboardAfterMs = 7 * DAY_MS;
      writeSessionEntry(
        database,
        "AGENT:MAIN:DASHBOARD:ALIAS",
        { sessionId: "pending-dashboard", updatedAt: now - 8 * DAY_MS, lastActivityAt: now },
        { allowStoredAliases: true, canonicalPreviousEntry: null },
      );
    } else if (scenario === "pending namespace prefixes") {
      maintenance.archiveDashboardAfterMs = 7 * DAY_MS;
      writeSessionEntry(database, "agent:main:dashboard:certified", {
        sessionId: "certified-dashboard",
        updatedAt: now - 8 * DAY_MS,
        lastActivityAt: now,
      });
      for (const [index, storedKey] of ["agent:", "agent:foo"].entries()) {
        writeSessionEntry(
          database,
          storedKey,
          {
            sessionId: `pending-prefix-${index}`,
            updatedAt: now,
          },
          { allowStoredAliases: true, canonicalPreviousEntry: null },
        );
      }
    } else if (scenario === "recent activity") {
      maintenance.pruneAfterMs = 60 * DAY_MS;
      maintenance.preserveRecentMs = 7 * DAY_MS;
      const fields = [
        "updatedAt",
        "lastActivityAt",
        "lastInteractionAt",
        "sessionStartedAt",
      ] as const;
      for (const [index, field] of fields.entries()) {
        writeSessionEntry(database, key(index), {
          sessionId: `activity-${index}`,
          updatedAt: now - 31 * DAY_MS,
          [field]: now - index * DAY_MS,
        });
      }
    } else {
      maintenance.preserveRecentMs = scenario === "expired recent activity" ? 7 * DAY_MS : null;
      maintenance.pruneAfterMs = scenario === "disabled ages" ? 0 : 30 * DAY_MS;
      writeSessionEntry(database, key(0), {
        sessionId: "ordinary",
        updatedAt: now - 8 * DAY_MS,
      });
    }
    ageFacts.recordSessionEntryMaintenanceAgeFact(database, maintenance, now);
    return {
      nextAgeAt: ageFacts.readSessionEntryMaintenanceAgeFact(database.db, maintenance)?.next.at,
      nextMaintenanceAt: ageFacts.readSessionEntryMaintenanceNextAgeAt(database, maintenance),
    };
  }, options);
  const expected = {
    "shared dashboards": now + 6 * DAY_MS + 1,
    "pending dashboard alias": now + 7 * DAY_MS + 1,
    "pending namespace prefixes": now + 7 * DAY_MS + 1,
    "recent activity": now + 4 * DAY_MS + 1,
    "expired recent activity": now + 22 * DAY_MS + 1,
    "disabled ages": Infinity,
  };
  expect(result.nextAgeAt).toBe(expected[scenario]);
  expect(result.nextMaintenanceAt).toBe(
    Math.min(expected[scenario], now + ageFacts.SESSION_ENTRY_MAINTENANCE_INTERVAL_MS),
  );
});
