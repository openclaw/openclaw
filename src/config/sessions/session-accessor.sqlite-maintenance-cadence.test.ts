import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { loadSessionEntry } from "./session-accessor.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  SessionEntryMaintenanceInput,
  SqliteSessionReclamationPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import * as ageFacts from "./session-accessor.sqlite-maintenance-age.js";
import { prepareSessionEntryMaintenanceInDatabase } from "./session-accessor.sqlite-maintenance-store.js";
import {
  prepareSessionMaintenanceInWorker,
  reclaimSessionMaintenanceInTransaction,
} from "./session-accessor.sqlite-maintenance-transaction.js";
import { applySessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { commitSessionEntryReplacementsInDatabase } from "./session-accessor.sqlite-replacement-state.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import * as maintenanceRuntime from "./store-maintenance-runtime.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DAY_MS = 24 * 60 * 60 * 1000;
const key = (index: number) => `agent:main:cadence-${index}`;
const readEntry = (storePath: string, index = 0) =>
  loadSessionEntry({ storePath, sessionKey: key(index) });

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

const agePolicy = (
  pruneAfterMs: number,
  overrides: Partial<ResolvedSessionMaintenanceConfig> = {},
): ResolvedSessionMaintenanceConfig => ({
  ...resolveMaintenanceConfigFromInput(),
  pruneAfterMs,
  archiveDashboardAfterMs: null,
  preserveRecentMs: null,
  ...overrides,
});

it("drains expired sessions in bounded pages without losing archived entries", async () => {
  const { database, options, storePath } = createStore(500, Date.now() - 90 * DAY_MS);
  const operation = await createPlanningOperation(options, {
    maxAgeEntries: 64,
    maxCapEntries: 64,
    maintenance: resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxEntries: 1000,
      pruneAfter: "30d",
      preserveRecent: "1d",
    }),
  });
  const archived: string[] = [];
  for (let pass = 0; pass < 10; pass += 1) {
    const apply = runSqliteReadSnapshotSync(database.db, () =>
      prepareSessionEntryMaintenanceInDatabase(
        database,
        operation.input,
        () => operation.input.preservation,
      ),
    );
    const plan = runOpenClawAgentWriteTransaction((current) => apply(current), options);
    expect(plan.archived).toBeLessThanOrEqual(64);
    archived.push(...plan.archivedEntries.map((entry) => entry.sessionKey));
    if (!plan.ageContinuation) {
      break;
    }
    operation.input.ageContinuation = plan.ageContinuation;
  }
  expect(archived.toSorted()).toEqual(
    Array.from({ length: 500 }, (_, index) => key(index)).toSorted(),
  );
  expect(
    Array.from(
      { length: 500 },
      (_, index) => loadSessionEntry({ storePath, sessionKey: key(index) })?.archiveReason,
    ),
  ).toEqual(Array.from({ length: 500 }, () => "age-retention"));
});

it("pins age eligibility across pages and immediately revisits the next due boundary", async () => {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const { options, storePath } = createStore(64, now - 2_000);
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, key(64), { sessionId: "cadence-64", updatedAt: now - 999 });
  }, options);
  const operation = await createPlanningOperation(options, {
    maxAgeEntries: 64,
    maxCapEntries: 64,
    maintenance: agePolicy(1_000, { maxEntries: 1_000 }),
  });
  const pass = () => {
    const result = reclaimSessionMaintenanceInTransaction(operation, {});
    if (result.kind !== "maintenance-plan") {
      throw new Error("Expected an admitted age-retention page");
    }
    return result;
  };
  const first = pass();
  expect(first.value.archived).toBe(64);
  expect(first.value.ageContinuation).toMatchObject({ at: now });
  operation.input.ageContinuation = first.value.ageContinuation;
  vi.setSystemTime(now + 5);
  const last = pass();
  expect(last.value).toMatchObject({ archived: 0, entryRemovals: [] });
  expect(last.value.ageContinuation).toBeUndefined();
  expect(last.nextAt).toBe(now + 2);
  expect(readEntry(storePath, 64)?.archivedAt).toBeUndefined();

  delete operation.input.ageContinuation;
  const next = pass();
  expect(next.value.archivedEntries).toEqual([{ sessionKey: key(64), sessionId: "cadence-64" }]);
  expect(readEntry(storePath, 64)?.archiveReason).toBe("age-retention");
});

async function createPlanningOperation(
  options: ReturnType<typeof createStore>["options"],
  input: Partial<SessionEntryMaintenanceInput> = {},
): Promise<Extract<SqliteSessionReclamationPlan, { kind: "maintenance-plan" }>> {
  const preservation = await prepareSessionMaintenancePreservation(options.path);
  onTestFinished(preservation.dispose);
  return {
    kind: "maintenance-plan",
    databaseOptions: resolveSessionReclamationDatabaseOptions(options),
    materializedPlans: [],
    input: {
      maintenance: resolveMaintenanceConfigFromInput(),
      storePath: options.path,
      archiveDirectory: path.join(path.dirname(options.path), "archives"),
      preservation: preservation.capture(),
      ...input,
    },
  };
}

function renameEntry(storePath: string, index: number, label: string) {
  return replaceEntryInDatabase(storePath, index, (entry) => ({ ...entry, label }));
}

// Observe the same SQL owner used by the worker, with its clock and connection in this isolate.
async function replaceEntryInDatabase(
  storePath: string,
  index: number,
  update: (entry: SessionEntry) => SessionEntry,
) {
  const preservation = await prepareSessionMaintenancePreservation(storePath);
  try {
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
              preservation: preservation.capture(),
              storePath,
            },
          },
          () => {},
        );
      },
      { agentId: "main", path: storePath },
    );
  } finally {
    preservation.dispose();
  }
}

it("forced maintenance bypasses ordinary-write slack", async () => {
  const { options } = createStore(51);
  const operation = await createPlanningOperation(options, {
    maintenance: agePolicy(30 * DAY_MS, { maxEntries: 50 }),
  });
  expect(reclaimSessionMaintenanceInTransaction(operation, {})).toMatchObject({
    value: { archived: 0 },
  });
  operation.input.forceMaintenance = true;
  expect(reclaimSessionMaintenanceInTransaction(operation, {})).toMatchObject({
    value: { archived: 1, capped: 1 },
  });
});

it("reconsiders retention after a foreign backdate", async () => {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const { database, storePath } = createStore(2, now);
  await renameEntry(storePath, 0, "warm age facts");
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
  await renameEntry(storePath, 0, "reconsider after invalidation");
  expect(readEntry(storePath, 1)).toMatchObject({
    archiveReason: "age-retention",
  });
});

it("keeps an age boundary due when it passes between planning and recording the fact", async () => {
  const now = Date.now();
  const { storePath } = createStore(1, now);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue(agePolicy(1_000));
  const record = ageFacts.recordSessionEntryMaintenanceAgeFact;
  vi.spyOn(ageFacts, "recordSessionEntryMaintenanceAgeFact").mockImplementationOnce((...args) => {
    vi.setSystemTime(now + 1_001);
    return record(...args);
  });
  await renameEntry(storePath, 0, "boundary passed during planning");
  expect(readEntry(storePath)?.archivedAt).toBeUndefined();
  await renameEntry(storePath, 0, "reconsider the elapsed boundary");
  expect(readEntry(storePath)).toMatchObject({
    archiveReason: "age-retention",
  });
});

it("does not retain an age fact from a rolled-back archive", async () => {
  const { options, storePath } = createStore(1, Date.now() - 31 * DAY_MS);
  const preservation = await prepareSessionMaintenancePreservation(storePath);
  onTestFinished(preservation.dispose);
  const maintain = (database: ReturnType<typeof openOpenClawAgentDatabase>) =>
    applySessionEntryMaintenance(database, {
      preservation: preservation.capture,
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
  expect(readEntry(storePath)?.archivedAt).toBeUndefined();
  expect(runOpenClawAgentWriteTransaction(maintain, options).archived).toBe(1);
  expect(readEntry(storePath)).toMatchObject({
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
  const maintenance: ResolvedSessionMaintenanceConfig = agePolicy(30 * DAY_MS);
  const result = runOpenClawAgentWriteTransaction((database) => {
    const seed = (
      sessionKey: string,
      sessionId: string,
      daysAgo: number,
      fields: Partial<SessionEntry> = {},
      alias = false,
    ) =>
      writeSessionEntry(
        database,
        sessionKey,
        { sessionId, updatedAt: now - daysAgo * DAY_MS, ...fields },
        alias ? { allowStoredAliases: true, canonicalPreviousEntry: null } : undefined,
      );
    seed("agent:main:main", "protected-primary", 100);
    if (scenario === "shared dashboards") {
      maintenance.archiveDashboardAfterMs = 7 * DAY_MS;
      seed("agent:main:dashboard:first", "first-dashboard", 8, { lastActivityAt: now });
      seed("agent:zeta:dashboard:second", "second-dashboard", 8, {
        lastInteractionAt: now - DAY_MS,
      });
    } else if (scenario === "pending dashboard alias") {
      maintenance.archiveDashboardAfterMs = 7 * DAY_MS;
      seed("AGENT:MAIN:DASHBOARD:ALIAS", "pending-dashboard", 8, { lastActivityAt: now }, true);
    } else if (scenario === "pending namespace prefixes") {
      maintenance.archiveDashboardAfterMs = 7 * DAY_MS;
      seed("agent:main:dashboard:certified", "certified-dashboard", 8, { lastActivityAt: now });
      for (const [index, storedKey] of ["agent:", "agent:foo"].entries()) {
        seed(storedKey, `pending-prefix-${index}`, 0, {}, true);
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
        seed(key(index), `activity-${index}`, 31, { [field]: now - index * DAY_MS });
      }
    } else {
      maintenance.preserveRecentMs = scenario === "expired recent activity" ? 7 * DAY_MS : null;
      maintenance.pruneAfterMs = scenario === "disabled ages" ? 0 : 30 * DAY_MS;
      seed(key(0), "ordinary", 8);
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
  async (mutation) => {
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
    const operation = await createPlanningOperation(
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
        expect(readEntry(storePath)?.label).toBe("newer");
      }
      expect(readEntry(storePath)?.archivedAt).toBeUndefined();
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
        expect(readEntry(storePath)).toMatchObject({
          label: "newer",
          archiveReason: "age-retention",
        });
      } finally {
        fresh.release();
      }
    }
  },
);

it("commits a prepared plan after an unrelated foreign write", async () => {
  const { database, options } = createStore(1, Date.now() - 31 * DAY_MS);
  const operation = await createPlanningOperation(options);
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
