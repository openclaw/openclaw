import { statSync } from "node:fs";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { racePromiseWithAbortSignal as abortable } from "../../infra/abort-signal.js";
import * as sqlite from "../../infra/node-sqlite.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  maintenancePreparationFixture as makeFixture,
  observeSessionMaintenancePlanningWorker as observePlanning,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import { runSqliteSessionReclamation as reclaim } from "./session-accessor.sqlite-reclamation-run.js";
import {
  createSessionMaintenanceStatisticsOperation as statistics,
  createSessionMaintenanceFinalizationOperation as finalization,
} from "./session-accessor.sqlite-reclamation.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";

function waitForGate(gate: Promise<void>, operation: Promise<unknown>, signal: AbortSignal) {
  return abortable(
    awaitGateBeforeSettlement(gate, operation, "Maintenance settled before its expected boundary"),
    signal,
  );
}

function pausedStep() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  return {
    entered: entered.promise,
    resume: resume.resolve,
    enter() {
      entered.resolve();
      return resume.promise;
    },
  };
}

export function registerSessionMaintenancePreparationTests() {
  it.each(["no-op", "preservation", "statistics", "empty-finalization"] as const)(
    "keeps resident rows warm after %s Worker maintenance",
    async (operation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { stale, database, plan: seededPlan } = makeFixture(state);
        const maintenancePlan: Extract<SqliteSessionReclamationPlan, { kind: "maintenance-plan" }> =
          seededPlan;
        if (operation !== "preservation") {
          replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: Date.now() });
        }
        const { databaseOptions } = maintenancePlan;
        maintenancePlan.input.preservation.providerKeys = [stale.sessionKey];
        maintenancePlan.input.maintenance.pruneAfterMs = 60 * 60 * 1000;
        const originalFile = statSync(database.path, { bigint: true });
        const plan: SqliteSessionReclamationPlan =
          operation === "statistics"
            ? statistics(databaseOptions)
            : operation === "empty-finalization"
              ? finalization({
                  agentId: "main",
                  databaseOptions,
                  entries: [],
                  materializedPlans: [],
                })
              : maintenancePlan;
        const published: unknown[] = [];
        const unsubscribe = sessionChanges.subscribe((change) => {
          const scope = "all" in change ? change.scope : change;
          if (typeof scope === "object" && scope.storePath === database.path) {
            published.push(change);
          }
        });
        const completed = vi.fn();
        const diagnostics = {};
        try {
          const result = await reclaim({
            diagnostics,
            onWorkerResult: completed,
            plan,
          });
          expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
          expect(result.kind).toBe(plan.kind);
          expect(completed).toHaveBeenCalledExactlyOnceWith(
            result,
            `${originalFile.dev}:${originalFile.ino}`,
          );
          expect(published).toEqual([]);
          if (operation === "preservation") {
            expect(loadSessionEntry(stale)?.archivedAt).toBeUndefined();
          }
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it.for(["maintenance-plan", "maintenance-statistics"] as const)(
    "runs cold %s without opening or querying a host database",
    async (kind, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const fixture = makeFixture(state);
        const plan =
          kind === "maintenance-plan" ? fixture.plan : statistics(fixture.plan.databaseOptions);
        const opened = vi.spyOn(sqlite, "openNodeSqliteDatabase");
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        opened.mockClear();
        const sql = observeHostDataSql();
        const diagnostics: SqliteSessionReclamationDiagnostics = {};
        const archiveGate = pausedStep();
        const archiveSettled = vi.fn();
        const heldArchive = runExclusiveSqliteTranscriptArchiveWorker(async () => {
          await archiveGate.enter();
        });
        void heldArchive.then(archiveSettled, archiveSettled);
        let pending: ReturnType<typeof reclaim> | undefined;
        let archive: PromiseSettledResult<Awaited<typeof heldArchive>>;
        try {
          await abortable(archiveGate.entered, signal);
          pending = reclaim({
            plan,
            diagnostics,
          });
          const result = await abortable(pending, signal);
          expect(archiveSettled).not.toHaveBeenCalled();
          expect(result.kind).toBe(kind);
          expect(diagnostics.workerThreadId).toBeGreaterThan(0);
          expect(opened.mock.calls).toEqual([]);
          expect(sql.queries).toEqual([]);
          if (result.kind === "maintenance-plan") {
            expect(result.value.archived).toBe(1);
            expect(result.value.archivedEntries).toEqual(fixture.archivedEntries);
            expect(result.value.entryRemovals).toEqual([]);
          } else if (result.kind === "maintenance-statistics") {
            expect(result.value).toBe(true);
          }
        } finally {
          archiveGate.resume();
          [archive] = await Promise.allSettled([
            heldArchive,
            ...(pending ? [pending] : []),
          ] as const);
          sql.restore();
          opened.mockRestore();
        }
        if (archive.status === "rejected") {
          throw archive.reason;
        }
        expect(loadSessionEntry(fixture.active)?.sessionId).toBe("active");
        if (kind === "maintenance-plan") {
          expect(loadSessionEntry(fixture.stale)).toMatchObject({
            sessionId: "stale",
            archivedAt: expect.any(Number),
            archiveReason: "age-retention",
          });
        }
      });
    },
  );

  it("lets foreground changes to selected rows invalidate maintenance without caller-thread data SQL", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { active, stale, database, plan, archivedEntries } = makeFixture(state);
      const preparation = pausedStep();
      let preparations = 0;
      const published: string[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => {
        if (
          "sessionKey" in change &&
          change.storePath === database.path &&
          change.sessionKey === stale.sessionKey
        ) {
          published.push(change.sessionKey);
        }
      });
      observePlanning({
        async afterPrepare() {
          if (++preparations === 1) {
            await preparation.enter();
          }
        },
      });
      const sql = observeHostDataSql();
      const pending = reclaim({ plan });
      let foreground: Promise<void> | undefined;
      let retry: ReturnType<typeof reclaim> | undefined;
      try {
        await waitForGate(preparation.entered, pending, signal);
        foreground = applySessionEntryExactReplacements({
          storePath: database.path,
          sessionKeys: [stale.sessionKey],
          skipMaintenance: true,
          update: ([row]) => ({
            result: undefined,
            replacements: [
              {
                sessionKey: stale.sessionKey,
                entry: {
                  ...expectDefined(row, "foreground session row").entry,
                  label: "foreground progressed",
                },
              },
            ],
          }),
        });
        await abortable(foreground, signal);
        expect(published).toEqual([stale.sessionKey]);
        preparation.resume();
        await expect(pending).resolves.toEqual({ kind: "maintenance-plan-stale" });
        expect(published).toEqual([stale.sessionKey]);
        retry = reclaim({ plan });
        await expect(retry).resolves.toMatchObject({
          kind: "maintenance-plan",
          value: { archived: 1, archivedEntries, entryRemovals: [] },
        });
        expect(published).toEqual([stale.sessionKey, stale.sessionKey]);
        expect(sql.queries).toEqual([]);
      } finally {
        preparation.resume();
        await Promise.allSettled([pending, foreground, retry]);
        sql.restore();
        unsubscribe();
      }
      expect(loadSessionEntry(stale)?.label).toBe("foreground progressed");
      expect(loadSessionEntry(active)?.archivedAt).toBeUndefined();
      expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
    });
  });

  it.for(["caller revocation", "lost preparation reply"] as const)(
    "preserves rows and admitted readers after %s and lets the next maintenance pass proceed",
    async (failure, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { active, stale, plan, archivedEntries } = makeFixture(state);
        const admitted = await loadSessionEntryForAdmission(active);
        const claim = admitted.databaseClaim;
        if (!("reader" in claim) || !claim.reader) {
          throw new Error("Fixture requires an admitted session reader");
        }
        const preparation = pausedStep();
        let preparations = 0;
        const cancelled = new Error(`Maintenance ${failure} after native preparation`);
        observePlanning({
          async afterPrepare() {
            if (++preparations === 1) {
              await preparation.enter();
              if (failure === "lost preparation reply") {
                throw cancelled;
              }
            }
          },
        });
        let current = true;
        const published = vi.fn();
        let sql = observeHostDataSql();
        const first = reclaim({
          plan,
          onWorkerResult: published,
          assertCommitAllowed() {
            if (!current) {
              throw cancelled;
            }
          },
        });
        const firstOutcome = first.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let second: ReturnType<typeof reclaim> | undefined;
        try {
          await waitForGate(preparation.entered, firstOutcome, signal);
          current = failure !== "caller revocation";
          preparation.resume();
          expect(await firstOutcome).toEqual({ error: cancelled });
          expect(published).not.toHaveBeenCalled();
          expect(sql.queries).toEqual([]);
          sql.restore();
          await expect(
            claim.reader.withRead(
              { sessionKeys: [active.sessionKey] },
              () => {},
              (cohort) => cohort.entries.find((row) => row.sessionKey === active.sessionKey)?.entry,
            ),
          ).resolves.toMatchObject({ sessionId: "active" });
          expect(loadSessionEntry(stale)?.archivedAt).toBeUndefined();
          sql = observeHostDataSql();
          second = reclaim({ plan });
          await expect(second).resolves.toMatchObject({
            kind: "maintenance-plan",
            value: { archived: 1, archivedEntries },
          });
          expect(published).not.toHaveBeenCalled();
          expect(sql.queries).toEqual([]);
        } finally {
          preparation.resume();
          await Promise.allSettled([firstOutcome, second]);
          await claim.release();
          sql.restore();
        }
        expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
      });
    },
  );
  it.runIf(process.platform !== "win32")(
    "joins the prepared native owner on path replacement before rejecting its caller",
    async ({ signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { stale, database, plan, archivedEntries } = makeFixture(state);
        const successorPath = state.statePath("successor", "store.sqlite");
        replaceSessionEntrySync(
          { sessionKey: stale.sessionKey, storePath: successorPath },
          { sessionId: "successor", updatedAt: 1, label: "successor untouched" },
        );
        await closeOpenClawAgentDatabaseByPathAsync(successorPath);
        const successorBytes = await fs.readFile(successorPath);
        const heldPath = `${database.path}.held`;
        const replacementPath = `${database.path}.replacement`;
        await fs.writeFile(replacementPath, successorBytes);
        const preparation = pausedStep();
        let nativeClosed = false;
        let closeNative: (() => Promise<void>) | undefined;
        observePlanning({
          async afterPrepare(native) {
            if (closeNative) {
              return;
            }
            const close = native.store.close.bind(native.store);
            closeNative = close;
            vi.spyOn(native.store, "close").mockImplementation(async () => {
              await close();
              nativeClosed = true;
            });
            await preparation.enter();
          },
        });
        const sql = observeHostDataSql();
        const pending = reclaim({ plan });
        const outcome = pending.then(
          (value) => ({ kind: "returned" as const, value, nativeClosed }),
          (error: unknown) => ({ kind: "failed" as const, error, nativeClosed }),
        );
        let originalMoved = false;
        let replacementInstalled = false;
        try {
          await waitForGate(preparation.entered, outcome, signal);
          expect(nativeClosed).toBe(false);
          await fs.rename(database.path, heldPath);
          originalMoved = true;
          await fs.rename(replacementPath, database.path);
          replacementInstalled = true;
          preparation.resume();
          const result = await abortable(outcome, signal);
          if (result.kind !== "failed") {
            throw new Error("Prepared maintenance accepted a replacement database");
          }
          const originalError =
            result.error instanceof AggregateError ? result.error.cause : result.error;
          expect(originalError).toMatchObject({
            message: "SQLite database file identity changed before existing-only open",
          });
          expect(result.nativeClosed).toBe(true);
          expect(await fs.readFile(database.path)).toEqual(successorBytes);
          expect(sql.queries).toEqual([]);
        } finally {
          preparation.resume();
          await outcome;
          try {
            // Join the real handle even on the unfixed path before restoring its original file.
            await closeNative?.();
          } finally {
            sql.restore();
            try {
              if (replacementInstalled) {
                await fs.rename(database.path, replacementPath);
              }
            } finally {
              if (originalMoved) {
                await fs.rename(heldPath, database.path);
              }
            }
          }
        }
        expect(loadSessionEntry(stale)).toMatchObject({ sessionId: "stale" });
        expect(loadSessionEntry(stale)?.archivedAt).toBeUndefined();
        await expect(reclaim({ plan })).resolves.toMatchObject({
          kind: "maintenance-plan",
          value: { archivedEntries },
        });
        expect(
          loadSessionEntry({ sessionKey: stale.sessionKey, storePath: successorPath }),
        ).toMatchObject({
          sessionId: "successor",
          label: "successor untouched",
        });
      });
    },
  );
}
