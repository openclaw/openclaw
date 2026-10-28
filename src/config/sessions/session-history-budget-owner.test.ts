import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { listDirectoryTreeStrictSync } from "../../infra/directory-walk.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as queue from "../../shared/store-writer-queue.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { clearOpenClawAgentDatabaseValidationCache } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { drainSessionDiskBudgetWorkers } from "./disk-budget-runtime.js";
import * as diskBudget from "./disk-budget.js";
import { appendTranscriptMessage, resetSessionEntryLifecycle } from "./session-accessor.js";
import * as archiveStore from "./session-accessor.sqlite-archive-store.js";
import * as archives from "./session-accessor.sqlite-archive.js";
import { patchSessionEntryCore, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as entryEviction from "./session-accessor.sqlite-lifecycle.js";
import * as reclamation from "./session-accessor.sqlite-reclamation-run.js";
import {
  joinSessionHistoryBudgetSweeps,
  type SessionHistoryBudgetQueueObservation,
} from "./session-history-budget.test-support.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const states: OpenClawTestState[] = [];
const work: Promise<unknown>[] = [];
const releaseGates: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseGates.splice(0)) {
    release();
  }
  await Promise.allSettled(work.splice(0));
  vi.restoreAllMocks();
  await drainSessionDiskBudgetWorkers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  for (const state of states.splice(0).toReversed()) {
    await state.cleanup();
  }
});

function readRow(databasePath: string, sql: string, ...values: SQLInputValue[]) {
  // Independent read-only evidence must not register, lease, or warm an agent owner.
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...values);
  } finally {
    database.close();
  }
}

function historyRow(
  databasePath: string,
  table: "session_windows" | "session_transcript_archives",
  sessionId: string,
) {
  return readRow(databasePath, `SELECT session_id FROM ${table} WHERE session_id = ?`, sessionId);
}

function currentRow(databasePath: string, sessionKey: string) {
  return readRow(
    databasePath,
    "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
    sessionKey,
  );
}

async function makeState(scenario: "minimal" | "empty" = "minimal") {
  const state = await createOpenClawTestState({ layout: "state-only", scenario });
  states.push(state);
  return state;
}

function budgetConfig(maxDiskBytes = 1, highWaterBytes = maxDiskBytes) {
  return resolveMaintenanceConfigFromInput({ mode: "enforce", maxDiskBytes, highWaterBytes });
}

function budgetCalls(spy: SessionHistoryBudgetQueueObservation) {
  return spy.mock.calls.filter(
    ([params]) => params.label === "enforceSqliteSessionHistoryDiskBudget",
  );
}

function assertHistory(databasePath: string, sessionId: string) {
  expect(historyRow(databasePath, "session_windows", sessionId)).toEqual({ session_id: sessionId });
}

function assertCurrent(databasePath: string, sessionKey: string, sessionId: string) {
  expect(currentRow(databasePath, sessionKey)).toEqual({ current_session_id: sessionId });
}

function observeFirstSweep(spy: SessionHistoryBudgetQueueObservation) {
  const index = spy.mock.calls.findIndex(
    ([params]) => params.label === "enforceSqliteSessionHistoryDiskBudget",
  );
  const outcome = spy.mock.results[index];
  if (!outcome || outcome.type !== "return" || !(outcome.value instanceof Promise)) {
    throw new Error("Real budget sweep was not queued");
  }
  const pending: Promise<unknown> = outcome.value;
  work.push(pending);
  return pending;
}

it.each([
  { layout: "canonical", trigger: "kick", victim: "history" },
  { layout: "canonical", trigger: "relative-kick", victim: "history" },
  { layout: "custom", trigger: "kick", victim: "history" },
  { layout: "shared", trigger: "kick", victim: "history" },
  { layout: "canonical", trigger: "patch", victim: "history" },
  { layout: "shared", trigger: "kick", victim: "cap-entry" },
  { layout: "canonical", trigger: "enforce", victim: "history" },
  { layout: "canonical", trigger: "inspect", victim: "history" },
] as const)(
  "retains $layout ownership for actual $trigger budget work on $victim",
  async ({ layout, trigger, victim }) => {
    const state = await makeState();
    const successor = state.path("successor-state");
    fs.mkdirSync(successor);
    const agentId = layout === "shared" ? "secondary" : "main";
    const storePath =
      layout === "canonical"
        ? path.join(state.sessionsDir(), "sessions.json")
        : state.path("custom", layout === "shared" ? "shared.sqlite" : "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    // The exact shared locator has a main schema owner but secondary logical rows.
    if (layout === "shared") {
      openOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
    }
    const sessionKey =
      victim === "cap-entry"
        ? `agent:${agentId}:explicit:budget-owner`
        : `agent:${agentId}:budget-owner`;
    const protectedKey = victim === "cap-entry" ? `agent:${agentId}:main` : sessionKey;
    const scope = { agentId, env: state.env, storePath, sessionKey };
    const originalId = "budget-owner-old";
    const currentId = "budget-owner-current";
    const marker = "synthetic retained history under original state";
    const queueSpy = vi.spyOn(queue, "runQueuedStoreWrite");
    replaceSessionEntrySync(scope, { sessionId: originalId, updatedAt: 1 });
    await appendTranscriptMessage(
      { ...scope, sessionId: originalId },
      { message: { role: "user", content: marker + "x".repeat(64 * 1024) } },
    );
    if (victim === "history") {
      await resetSessionEntryLifecycle({
        agentId,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        buildNextEntry: () => ({ sessionId: currentId, updatedAt: 2 }),
      });
    } else {
      // Referenced generations must use entry eviction, not unreferenced-history reclamation.
      replaceSessionEntrySync(scope, {
        sessionId: originalId,
        updatedAt: 1,
        archivedAt: 1,
        archiveReason: "active-session-cap",
      });
      replaceSessionEntrySync(
        { ...scope, sessionKey: protectedKey },
        { sessionId: currentId, updatedAt: 2 },
      );
    }
    await joinSessionHistoryBudgetSweeps(queueSpy, work);
    queueSpy.mockClear();
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId, env: state.env });
    const databasePath = target.path;
    assertHistory(databasePath, originalId);
    assertCurrent(databasePath, protectedKey, currentId);
    // Forget cached reads without revoking the active sweep's database workers.
    const databaseOptions = {
      agentId: target.agentId ?? "main",
      path: databasePath,
      env: state.env,
    };
    const forgetCachedDatabase = () => {
      const cached = getOpenClawAgentDatabaseIfOpen(databaseOptions);
      if (cached) {
        closeCachedOpenClawAgentDatabase(cached);
      }
      clearOpenClawAgentDatabaseValidationCache(state.root);
      expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
    };
    forgetCachedDatabase();

    let capEntryCalls = 0;
    const deleteEntry = entryEviction.deleteDiskBudgetSessionEntryLifecycle;
    vi.spyOn(entryEviction, "deleteDiskBudgetSessionEntryLifecycle").mockImplementation(
      async (...args) => {
        if (victim === "cap-entry" && args[0].target.canonicalKey === sessionKey) {
          capEntryCalls += 1;
          assertCurrent(databasePath, sessionKey, originalId);
          forgetCachedDatabase();
        }
        return await deleteEntry(...args);
      },
    );
    const order: string[] = [];
    const materialize = archives.materializeSessionHistoryEvictionPlan;
    vi.spyOn(archives, "materializeSessionHistoryEvictionPlan").mockImplementation(async (plan) => {
      const result = await materialize(plan);
      if (victim === "history" && plan.sessionId === originalId) {
        expect(result?.archive?.bytes.byteLength).toBeGreaterThan(0);
        assertHistory(databasePath, originalId);
        order.push("materialized while source exists");
      }
      return result;
    });
    const reclaim = reclamation.runSqliteSessionReclamation;
    vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
      const result = await reclaim(params);
      if (params.plan.kind === "history-eviction" && params.plan.sessionId === originalId) {
        expect(historyRow(databasePath, "session_windows", originalId)).toBeUndefined();
        expect(
          readRow(
            databasePath,
            "SELECT length(archive_blob) AS bytes FROM session_transcript_archives WHERE session_id = ?",
            originalId,
          )?.bytes,
        ).toBeGreaterThan(0);
        order.push("canonical archive durable after deletion");
      }
      if (victim === "cap-entry" && params.plan.kind === "entry") {
        expect(result).toMatchObject({ kind: "entry", value: { deleted: true } });
        expect(
          readRow(
            databasePath,
            "SELECT session_key FROM session_nodes WHERE session_key = ?",
            sessionKey,
          ),
        ).toBeUndefined();
        expect(historyRow(databasePath, "session_windows", originalId)).toBeUndefined();
        order.push("cap-archived entry durably deleted");
      }
      return result;
    });
    const publish = archiveStore.publishSessionStateArchives;
    vi.spyOn(archiveStore, "publishSessionStateArchives").mockImplementation(async (...args) => {
      const result = await publish(...args);
      const saved = result.find((archive) => archive.sessionId === originalId);
      if (saved) {
        expect(readSessionArchiveContentSync(saved.archivedPath)).toContain(marker);
        order.push("archive file published");
      }
      return result;
    });
    const measured = createDeferred();
    const release = createDeferred();
    releaseGates.push(() => release.resolve());
    let first = true;
    const measure = diskBudget.measureSessionPhysicalDiskUsage;
    vi.spyOn(diskBudget, "measureSessionPhysicalDiskUsage").mockImplementation(async (pathname) => {
      const usage = await measure(pathname);
      if (first && pathname === storePath) {
        first = false;
        expect(usage.totalBytes).toBeGreaterThan(1);
        measured.resolve();
        await release.promise;
      }
      return usage;
    });
    const maintenanceConfig = budgetConfig();
    let moveRelativeCwd: (() => void) | undefined;
    let sweep: Promise<unknown>;
    if (trigger === "patch") {
      // The ordinary patch kick has no force flag; advance past the 30-minute seed throttle.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1000);
      const updaterStarted = createDeferred();
      const finishUpdater = createDeferred();
      releaseGates.push(() => finishUpdater.resolve());
      const patch = patchSessionEntryCore(
        scope,
        async () => {
          updaterStarted.resolve();
          await finishUpdater.promise;
          return { label: "patch committed under original owner" };
        },
        { skipMaintenance: true, maintenanceConfig },
      );
      work.push(patch);
      await awaitGateBeforeSettlement(updaterStarted.promise, patch, "Patch ended before updater");
      // The patch must forward A to its late kick, even with ambient B.
      vi.stubEnv("OPENCLAW_STATE_DIR", successor);
      finishUpdater.resolve();
      await expect(patch).resolves.toMatchObject({
        sessionId: currentId,
        label: "patch committed under original owner",
      });
      sweep = observeFirstSweep(queueSpy);
    } else if (trigger === "kick" || trigger === "relative-kick") {
      let suppliedEnv: NodeJS.ProcessEnv | undefined;
      if (trigger === "relative-kick") {
        const cwd = vi.spyOn(process, "cwd").mockReturnValue(state.root);
        suppliedEnv = { ...state.env, OPENCLAW_STATE_DIR: "state" };
        expect(path.join(state.root, "state")).toBe(state.stateDir);
        expect(path.isAbsolute(storePath)).toBe(true);
        moveRelativeCwd = () => {
          cwd.mockReturnValue(successor);
        };
      }
      kickSessionHistoryDiskBudgetMaintenance({
        agentId,
        storePath,
        maintenanceConfig,
        force: true,
        ...(suppliedEnv ? { env: suppliedEnv } : {}),
      });
      sweep = observeFirstSweep(queueSpy);
    } else {
      const input = {
        agentId,
        storePath,
        mode: "enforce" as const,
        maintenance: maintenanceConfig,
      };
      sweep =
        trigger === "inspect"
          ? inspectSqliteSessionHistoryDiskBudget(input)
          : enforceSqliteSessionHistoryDiskBudget(input);
      work.push(sweep);
    }
    await awaitGateBeforeSettlement(measured.promise, sweep, "Sweep ended before measurement");
    vi.stubEnv("OPENCLAW_STATE_DIR", successor);
    moveRelativeCwd?.();
    // Drop A's reopened handle/validation before the real measurement returns.
    forgetCachedDatabase();
    release.resolve();
    if (trigger === "inspect") {
      await expect(sweep).resolves.toMatchObject({
        diskBudget: { overBudget: true, removedEntries: 0, removedFiles: 0 },
        wouldMutate: true,
      });
      expect(order).toEqual([]);
    } else {
      await expect(sweep).resolves.toMatchObject({ overBudget: true, removedEntries: 1 });
      expect(order).toEqual(
        victim === "history"
          ? [
              "materialized while source exists",
              "canonical archive durable after deletion",
              "archive file published",
            ]
          : ["cap-archived entry durably deleted"],
      );
    }
    expect(capEntryCalls).toBe(victim === "cap-entry" ? 1 : 0);
    // A one-byte high water can legitimately prune the new derived archive afterward.
    expect(historyRow(databasePath, "session_windows", originalId)).toEqual(
      trigger === "inspect" ? { session_id: originalId } : undefined,
    );
    if (victim === "cap-entry") {
      expect(historyRow(databasePath, "session_transcript_archives", originalId)).toBeUndefined();
    }
    assertCurrent(databasePath, protectedKey, currentId);
    expect(readRow(databasePath, "SELECT agent_id FROM schema_meta")).toEqual({ agent_id: "main" });

    // Do not open B to inspect it: that would create the failure under test.
    const successorFiles = listDirectoryTreeStrictSync(successor)
      .map((walkEntry) => walkEntry.relativePath)
      .map(String)
      .toSorted();
    const successorStatePath = resolveOpenClawStateSqlitePath({
      OPENCLAW_STATE_DIR: trigger === "relative-kick" ? path.join(successor, "state") : successor,
    });
    const successorRow = (sql: string) =>
      fs.existsSync(successorStatePath) ? readRow(successorStatePath, sql) : undefined;
    expect
      .soft(
        {
          registration: successorRow("SELECT agent_id, path FROM agent_databases LIMIT 1"),
          leases: successorRow("SELECT count(*) AS count FROM agent_database_leases"),
          files: successorFiles,
        },
        "budget work must not register, lease or create files under the successor state",
      )
      .toEqual({ registration: undefined, leases: undefined, files: [] });
  },
);

it("measures the disk budget after a committed patch but not after unchanged entry attempts", async () => {
  const state = await makeState();
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const scope = {
    agentId: "main",
    env: state.env,
    storePath,
    sessionKey: "agent:main:budget-noop",
  };
  const queueSpy = vi.spyOn(queue, "runQueuedStoreWrite");
  replaceSessionEntrySync(scope, { sessionId: "budget-noop", updatedAt: 1, label: "unchanged" });
  await joinSessionHistoryBudgetSweeps(queueSpy, work);
  queueSpy.mockClear();
  const measureSpy = vi.spyOn(diskBudget, "measureSessionPhysicalDiskUsage");
  const options = {
    skipMaintenance: true,
    preserveActivity: true,
    maintenanceConfig: budgetConfig(1024 * 1024 * 1024, 512 * 1024 * 1024),
  };
  try {
    for (const update of [() => null, () => ({ label: "unchanged" })]) {
      await expect(patchSessionEntryCore(scope, update, options)).resolves.toMatchObject({
        sessionId: "budget-noop",
        updatedAt: 1,
        label: "unchanged",
      });
    }
    await joinSessionHistoryBudgetSweeps(queueSpy, work);
    expect(budgetCalls(queueSpy)).toEqual([]);
    expect(measureSpy).not.toHaveBeenCalled();

    await expect(
      patchSessionEntryCore(scope, () => ({ label: "committed" }), options),
    ).resolves.toMatchObject({ sessionId: "budget-noop", label: "committed" });
    await joinSessionHistoryBudgetSweeps(queueSpy, work);
    expect(measureSpy).toHaveBeenCalledExactlyOnceWith(storePath);
  } finally {
    await joinSessionHistoryBudgetSweeps(queueSpy, work);
  }
});

it("skips an originating incognito budget kick without disk or background work", async () => {
  const state = await makeState("empty");
  const successor = state.path("successor-state");
  fs.mkdirSync(successor);
  const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
  const queueSpy = vi.spyOn(queue, "runQueuedStoreWrite");
  const measureSpy = vi.spyOn(diskBudget, "measureSessionPhysicalDiskUsage");
  kickSessionHistoryDiskBudgetMaintenance({
    agentId: "main",
    storePath: sentinel,
    force: true,
    maintenanceConfig: budgetConfig(),
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", successor);
  expect(budgetCalls(queueSpy)).toEqual([]);
  expect(measureSpy).not.toHaveBeenCalled();
  expect(fs.existsSync(path.dirname(sentinel))).toBe(false);
  expect(fs.readdirSync(successor)).toEqual([]);
});
