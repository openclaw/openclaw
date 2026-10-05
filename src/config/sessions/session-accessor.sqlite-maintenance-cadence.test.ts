import path from "node:path";
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
  appendTranscriptEventSync,
  assignSessionOwner,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
} from "./session-accessor.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  SessionEntryMaintenanceInput,
  SqliteSessionReclamationPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import * as candidates from "./session-accessor.sqlite-maintenance-candidates.js";
import {
  prepareSessionMaintenanceInWorker,
  reclaimSessionMaintenanceInTransaction,
} from "./session-accessor.sqlite-maintenance-transaction.js";
import { applySessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { commitSessionEntryReplacementsInDatabase } from "./session-accessor.sqlite-replacement-state.js";
import { captureSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import * as maintenanceRuntime from "./store-maintenance-runtime.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

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

function createPlanningOperation(
  options: ReturnType<typeof createStore>["options"],
  input: Partial<SessionEntryMaintenanceInput> = {},
): Extract<SqliteSessionReclamationPlan, { kind: "maintenance-plan" }> {
  return {
    kind: "maintenance-plan",
    databaseOptions: resolveSessionReclamationDatabaseOptions(options),
    materializedPlans: [],
    input: {
      maintenance: resolveMaintenanceConfigFromInput(),
      storePath: options.path,
      archiveDirectory: path.join(path.dirname(options.path), "archives"),
      preservation: captureSessionMaintenancePreservation(options.path),
      ...input,
    },
  };
}

function renameEntry(storePath: string, index: number, label: string) {
  replaceEntryInDatabase(storePath, index, (entry) => ({ ...entry, label }));
}

// Observe the same SQL owner used by the worker, with its clock and connection in this isolate.
function replaceEntryInDatabase(
  storePath: string,
  index: number,
  update: (entry: SessionEntry) => SessionEntry,
) {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const sessionKey = key(index);
      const row = readExactSessionEntryRow(database, sessionKey);
      if (!row) {
        throw new Error("Missing cadence fixture entry");
      }
      return commitSessionEntryReplacementsInDatabase(
        database,
        {
          expectedRows: new Map([[sessionKey, row]]),
          labelOwnerKeys: [],
          validationKeys: [sessionKey],
          replacements: [{ sessionKey, entry: update(row.entry) }],
          maintenance: {
            archiveDirectory: path.join(path.dirname(storePath), "archives"),
            maintenance: maintenanceRuntime.resolveMaintenanceConfig(),
            preservation: captureSessionMaintenancePreservation(storePath),
            storePath,
          },
        },
        () => {},
      );
    },
    { agentId: "main", path: storePath },
  );
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
  (kind) => {
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
      renameEntry(storePath, 0, "warm age facts");
      expect(factReads).toHaveBeenCalledTimes(1);
      expect(queries.counts).toEqual(expectedProbes);
      expect(queries.rowCounts).toEqual(expectedRows);
      for (let sequence = 1; sequence <= 3; sequence += 1) {
        writeMetadata(storePath, kind, sequence);
        renameEntry(storePath, 0, `renamed-${sequence}`);
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

it.each([
  { scenario: "4,000 fresh entries with foreign commits", count: 4_000, ageDays: 0 },
  { scenario: "eight-day entries with a protected primary", count: 2, ageDays: 8 },
])("does not rescan $scenario across 20 writes", ({ count, ageDays }) => {
  const { database, options, storePath } = createStore(count, Date.now() - ageDays * DAY_MS);
  if (ageDays) {
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, "agent:main:main", {
        sessionId: "primary",
        updatedAt: Date.now() - 100 * DAY_MS,
      });
    }, options);
    renameEntry(storePath, 0, "warm age facts");
  }
  const writer = ageDays ? undefined : new DatabaseSync(database.path);
  writer?.exec("CREATE TABLE maintenance_cadence_noise (value INTEGER)");
  const factReads = vi.spyOn(ageFacts, "recordSessionEntryMaintenanceAgeFact");
  const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
  const keyReads = vi.spyOn(candidates, "readSessionMaintenanceKeyProjection");
  const writes = 20;
  try {
    for (let index = 0; index < writes; index += 1) {
      writer?.prepare("INSERT INTO maintenance_cadence_noise VALUES (?)").run(index);
      renameEntry(storePath, index % count, `renamed-${index}`);
    }
  } finally {
    writer?.close();
  }
  for (let index = 0; index < Math.min(count, writes); index += 1) {
    expect(loadSessionEntry({ storePath, sessionKey: key(index) })).toMatchObject({
      label: `renamed-${ageDays ? writes - count + index : index}`,
    });
  }
  if (ageDays) {
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:main" })?.archivedAt,
    ).toBeUndefined();
  } else {
    expect(factReads).toHaveBeenCalledTimes(1);
  }
  expect(ageReads).toHaveBeenCalledTimes(ageDays ? 0 : 1);
  expect(keyReads).not.toHaveBeenCalled();
});

it.each([
  { scenario: "a write crosses the cap", count: 2, maxEntries: 2, force: false },
  {
    scenario: "forced maintenance bypasses ordinary-write slack",
    count: 51,
    maxEntries: 50,
    force: true,
  },
])("enforces the cap when $scenario", ({ count, maxEntries, force }) => {
  const { options, storePath } = createStore(count);
  const maintenanceConfig = { ...resolveMaintenanceConfigFromInput(), maxEntries };
  const maintain = (trigger = false) =>
    runOpenClawAgentWriteTransaction((database) => {
      if (trigger && !force) {
        writeSessionEntry(database, key(2), { sessionId: "cadence-2", updatedAt: Date.now() });
      }
      return applySessionEntryMaintenance(database, {
        archiveDirectory: path.join(path.dirname(storePath), "archives"),
        maintenanceConfig,
        forceMaintenance: trigger && force,
        storePath,
      });
    }, options);
  expect(maintain().archived).toBe(0);
  const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
  expect(maintain(true)).toMatchObject({ archived: 1, capped: 1 });
  if (!force) {
    expect(ageReads).toHaveBeenCalledTimes(1);
    const entries = [0, 1, 2].map((index) =>
      loadSessionEntry({ storePath, sessionKey: key(index) }),
    );
    expect(entries.every((entry) => entry !== undefined)).toBe(true);
    expect(entries.filter((entry) => entry?.archivedAt !== undefined)).toEqual([
      expect.objectContaining({ archiveReason: "active-session-cap" }),
    ]);
  }
});

it.each(["foreign backdate", "managed backdate", "shorter age policy"] as const)(
  "reconsiders retention after a %s",
  async (mutation) => {
    const now = Date.now();
    if (mutation === "foreign backdate") {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
    }
    const { database, storePath } = createStore(
      2,
      mutation === "shorter age policy" ? now - 2 * DAY_MS : now,
    );
    renameEntry(storePath, 0, "warm age facts");
    if (mutation === "managed backdate") {
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
    } else {
      if (mutation === "foreign backdate") {
        const writer = new DatabaseSync(database.path);
        const updatedAt = now - 31 * DAY_MS;
        try {
          writer
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.updatedAt', ?), updated_at = ? WHERE session_key = ?",
            )
            .run(updatedAt, updatedAt, key(1));
        } finally {
          writer.close();
        }
        vi.setSystemTime(now + 30 * 60 * 1_000 + 1);
      } else {
        expect(loadSessionEntry({ storePath, sessionKey: key(1) })?.archivedAt).toBeUndefined();
        vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue({
          ...resolveMaintenanceConfigFromInput(),
          pruneAfterMs: DAY_MS,
          archiveDashboardAfterMs: null,
        });
      }
      renameEntry(storePath, 0, "reconsider after invalidation");
    }
    expect(loadSessionEntry({ storePath, sessionKey: key(1) })).toMatchObject({
      archiveReason: "age-retention",
    });
  },
);

it("keeps an age boundary due when it passes between planning and recording the fact", () => {
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
    return record(...args);
  });
  renameEntry(storePath, 0, "boundary passed during planning");
  expect(loadSessionEntry({ storePath, sessionKey: key(0) })?.archivedAt).toBeUndefined();
  renameEntry(storePath, 0, "reconsider the elapsed boundary");
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

it("keeps age facts scoped to the store that produced them", () => {
  const fresh = createStore(1);
  const old = createStore(1, Date.now() - 31 * DAY_MS);
  renameEntry(fresh.storePath, 0, "fresh store");
  renameEntry(old.storePath, 0, "old store");
  expect(loadSessionEntry({ storePath: old.storePath, sessionKey: key(0) })).toMatchObject({
    archiveReason: "age-retention",
  });
  expect(
    loadSessionEntry({ storePath: fresh.storePath, sessionKey: key(0) })?.archivedAt,
  ).toBeUndefined();
});

it("reconsiders a session unarchived without changing its timestamp", () => {
  const { storePath } = createStore(1, Date.now() - 31 * DAY_MS);
  renameEntry(storePath, 0, "archive old session");
  renameEntry(storePath, 0, "warm archived-only facts");
  const archivedEntry = loadSessionEntry({ storePath, sessionKey: key(0) });
  expect(archivedEntry?.archivedAt).toEqual(expect.any(Number));
  const ageReads = vi.spyOn(candidates, "readSessionMaintenanceAgeCandidates");
  replaceEntryInDatabase(storePath, 0, (entry) => ({
    ...entry,
    archivedAt: undefined,
    archiveReason: undefined,
  }));
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

it.each([
  "local entry",
  "foreign entry",
  "transcript append",
  "protected parent",
  "active ancestor",
  "provider",
  "work-id",
  "lifecycle-id",
] as const)(
  "discards a prepared maintenance snapshot after %s changes its admission",
  (mutation) => {
    const entryChanged = mutation === "local entry" || mutation === "foreign entry";
    const candidateChanged = mutation === "transcript append" || mutation === "protected parent";
    const { database, options, storePath } = createStore(
      entryChanged ? 1 : 2,
      Date.now() - 31 * DAY_MS,
    );
    const childKey = key(1);
    if (!entryChanged) {
      writeSessionEntry(database, childKey, {
        sessionId: "cadence-1",
        updatedAt: Date.now(),
        ...(candidateChanged ? {} : { parentSessionKey: key(0) }),
      });
    }
    const operation = createPlanningOperation(
      options,
      entryChanged
        ? {}
        : candidateChanged
          ? { activeSessionKeys: [childKey] }
          : { preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] } },
    );
    const prepared = prepareSessionMaintenanceInWorker(operation);
    const writer = mutation === "foreign entry" ? new DatabaseSync(database.path) : undefined;
    try {
      if (entryChanged) {
        expect(database.db.isTransaction).toBe(false);
      }
      // A write can finish after preparation and before maintenance enters its writer.
      if (writer) {
        writer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', 'newer') WHERE session_key = ?",
          )
          .run(key(0));
        // The foreign writer certifies its valid postimage, like the ordinary entry owner.
        writer
          .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
          .run(key(0));
      } else if (mutation === "local entry") {
        writeSessionEntry(database, key(0), {
          sessionId: "cadence-0",
          updatedAt: Date.now() - 31 * DAY_MS,
          label: "newer",
        });
      } else if (mutation === "transcript append") {
        expect(
          appendTranscriptEventSync(
            { storePath, sessionKey: key(0), sessionId: "cadence-0" },
            { type: "custom", id: "concurrent-event", data: { synthetic: true } },
          ).ok,
        ).toBe(true);
      } else if (mutation === "protected parent") {
        writeSessionEntry(database, childKey, {
          sessionId: "cadence-1",
          updatedAt: Date.now(),
          parentSessionKey: key(0),
        });
      } else {
        operation.input.activeSessionKeys = mutation === "active ancestor" ? [childKey] : [];
        operation.input.preservation = {
          providerKeys: mutation === "provider" ? [key(0)] : [],
          workIdentities: mutation === "work-id" ? ["cadence-0"] : [],
          lifecycleIdentities: mutation === "lifecycle-id" ? ["cadence-0"] : [],
        };
      }
      expect(reclaimSessionMaintenanceInTransaction(operation, {}, prepared)).toEqual({
        kind: "maintenance-plan-stale",
      });
      if (entryChanged) {
        expect(loadSessionEntry({ storePath, sessionKey: key(0) })?.label).toBe("newer");
      }
      expect(loadSessionEntry({ storePath, sessionKey: key(0) })?.archivedAt).toBeUndefined();
    } finally {
      prepared.release();
      writer?.close();
    }
    if (entryChanged) {
      const fresh = prepareSessionMaintenanceInWorker(operation);
      try {
        expect(reclaimSessionMaintenanceInTransaction(operation, {}, fresh)).toMatchObject({
          kind: "maintenance-plan",
          value: { archived: 1 },
        });
        expect(loadSessionEntry({ storePath, sessionKey: key(0) })).toMatchObject({
          label: "newer",
          archiveReason: "age-retention",
        });
      } finally {
        fresh.release();
      }
    }
  },
);

it("commits a prepared plan after an unrelated foreign write", () => {
  const { database, options } = createStore(1, Date.now() - 31 * DAY_MS);
  const operation = createPlanningOperation(options);
  const prepared = prepareSessionMaintenanceInWorker(operation);
  const writer = new DatabaseSync(database.path);
  try {
    writer.exec("CREATE TABLE maintenance_unrelated_noise (value INTEGER)");
    expect(reclaimSessionMaintenanceInTransaction(operation, {}, prepared)).toMatchObject({
      kind: "maintenance-plan",
      value: { archived: 1 },
    });
  } finally {
    prepared.release();
    writer.close();
  }
});
