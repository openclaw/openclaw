import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { backfillSessionRowTranscriptFields } from "../../gateway/session-row-transcript-backfill.js";
import { prepareSessionCostUsageRefreshLock } from "../../infra/session-cost-usage-cache.sqlite.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { SESSION_ENTRY_MAINTENANCE_INTERVAL_MS } from "./session-accessor.sqlite-maintenance-age.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import {
  createSessionMaintenanceKickStore,
  observeSessionMaintenancePlanningWorker,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

it.each(["durable", "warm durable", "direct active", "runtime"] as const)(
  "preserves %s capacity rows through prepared maintenance",
  async (protection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const keys = ["agent:main:capacity-protected-0", "agent:main:capacity-protected-1"] as const;
      const write = (indexes: Array<0 | 1>) =>
        runOpenClawAgentWriteTransaction((database) => {
          for (const index of indexes) {
            const key = keys[index];
            writeSessionEntry(database, key, {
              sessionId: `capacity-protected-${index}`,
              updatedAt: Date.now(),
              modelSelectionLocked: protection === "durable" || protection === "warm durable",
            });
          }
        }, options);
      write(protection === "warm durable" ? [0] : [0, 1]);
      const plan = {
        kind: "maintenance-plan",
        databaseOptions: resolveSessionReclamationDatabaseOptions(options),
        materializedPlans: [],
        input: {
          activeSessionKeys:
            protection === "direct active" ? keys.map((key) => key.toUpperCase()) : [],
          archiveDirectory: state.sessionsDir(),
          storePath: path.join(state.sessionsDir(), "sessions.json"),
          maintenance: resolveMaintenanceConfigFromInput({
            mode: "enforce",
            maxEntries: 1,
            pruneAfter: "1d",
          }),
          preservation: {
            providerKeys: protection === "runtime" ? [...keys] : [],
            workIdentities: [],
            lifecycleIdentities: [],
          },
        },
      } satisfies SqliteSessionReclamationPlan;
      const expectReclamation = async (archived: number, durable: boolean) => {
        const result = await runSqliteSessionReclamation({ plan });
        expect(result).toMatchObject({ kind: "maintenance-plan", value: { archived } });
        expect(
          result.kind === "maintenance-plan" && result.value.durableNoCandidates === true,
        ).toBe(durable);
      };
      if (protection === "warm durable") {
        await expect(runSqliteSessionReclamation({ plan })).resolves.toMatchObject({
          kind: "maintenance-plan",
          ageFact: { entryCount: 1 },
        });
        write([1]);
      }
      if (protection === "direct active") {
        await expectReclamation(0, false);
        plan.input.activeSessionKeys = [];
      }
      const durable = protection === "durable" || protection === "warm durable";
      await expectReclamation(durable || protection === "runtime" ? 0 : 1, durable);
    });
  },
);

it.for(["transcript backfill", "usage rollup", "new entry", "protection removal"] as const)(
  "settles automatic no-op maintenance across %s according to its entry effects",
  async (overlap, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:maintenance-owner";
      const { request, scope, storePath, updatedAt } = createSessionMaintenanceKickStore({
        storePath: state.statePath("overlap-maintenance.sqlite"),
        key: sessionKey,
        pruneAfterMs: 86_400_000,
        workerMaintenance: true,
        maintenanceScopes: [],
      });
      vi.useRealTimers();
      request.maintenanceConfig.maxEntries = 1;
      const lockedKey = "agent:main:locked-owner";
      const newKey = "agent:main:new-entry";
      const preview = "Synthetic backfill preview";
      const transcriptScope = { agentId: "main", storePath, sessionKey, sessionId: sessionKey };
      const irrelevant = overlap === "transcript backfill" || overlap === "usage rollup";
      type CompletedPlan = Extract<SqliteSessionReclamationResult, { kind: "maintenance-plan" }>;
      const first = createDeferred<CompletedPlan | { kind: "maintenance-plan-stale" }>();
      const settled = createDeferred<CompletedPlan>();
      const scheduled = createDeferred<number>();
      let completedPlans = 0;
      let failedPlans = 0;
      let overlaps = 0;
      let usage: ReturnType<typeof prepareSessionCostUsageRefreshLock> | undefined;
      try {
        runOpenClawAgentWriteTransaction((database) => {
          for (const key of [sessionKey, lockedKey]) {
            writeSessionEntry(database, key, {
              sessionId: key,
              updatedAt,
              modelSelectionLocked: true,
            });
          }
        }, scope);
        if (overlap === "transcript backfill") {
          expect(
            replaceTranscriptEventsSync(transcriptScope, [
              { type: "session", id: sessionKey, version: 3 },
              {
                type: "message",
                id: "backfill-message",
                parentId: null,
                message: { role: "user", content: preview },
              },
            ]),
          ).toBe(true);
        }
        if (overlap === "usage rollup") {
          usage = prepareSessionCostUsageRefreshLock("main", storePath);
          expect(await usage.acquire()).toBe(true);
        }
        observeSessionMaintenancePlanningWorker({
          async afterPrepare() {
            if (overlaps++ >= 1) {
              return;
            }
            if (overlap === "transcript backfill") {
              await expect(
                backfillSessionRowTranscriptFields({
                  ...transcriptScope,
                  sessionEntry: { sessionId: sessionKey, updatedAt },
                }),
              ).resolves.toEqual({ lastMessagePreview: preview });
            } else if (overlap === "usage rollup") {
              await expect(
                usage!.writeRollup([
                  {
                    rollupId: "synthetic-rollup",
                    valueJson: Buffer.from('{"totalTokens":1}'),
                    blob: null,
                    updatedAt,
                  },
                ]),
              ).resolves.toBe(true);
            } else {
              const inserting = overlap === "new entry";
              const key = inserting ? newKey : lockedKey;
              const entry = { sessionId: key, updatedAt, modelSelectionLocked: false };
              await expect(
                applySessionEntryOperation(
                  { agentId: "main", storePath, sessionKey: key },
                  { kind: "fields", patch: entry },
                  {
                    skipMaintenance: true,
                    preserveActivity: true,
                    ...(inserting ? { fallbackEntry: entry } : {}),
                  },
                ),
              ).resolves.toMatchObject(entry);
            }
          },
        });
        const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
        const run = dispatch.getMockImplementation()!;
        dispatch.mockImplementation(async (params) => {
          const result = await run(params).catch((error: unknown) => {
            if (params.plan.kind === "maintenance-plan") {
              failedPlans++;
            }
            throw error;
          });
          if (result.kind === "maintenance-plan" || result.kind === "maintenance-plan-stale") {
            completedPlans++;
            first.resolve(result);
            if (result.kind === "maintenance-plan" && result.value.archived === 1) {
              settled.resolve(result);
            }
          }
          return result;
        });
        const setTimer = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
          const timer = setTimer(...args);
          const delay = args[1];
          // Observe the maintenance retry/deadline, excluding worker deadlines and idle timers.
          if (
            (completedPlans >= 1 || failedPlans > 0) &&
            typeof delay === "number" &&
            (delay <= 1_000 ||
              (delay > SESSION_ENTRY_MAINTENANCE_INTERVAL_MS / 2 &&
                delay <= SESSION_ENTRY_MAINTENANCE_INTERVAL_MS))
          ) {
            scheduled.resolve(delay);
          }
          return timer;
        });
        kickSessionEntryMaintenanceAfterWrite(request);
        const initial = await withinTest(first.promise, signal);
        if (irrelevant) {
          expect(initial).toMatchObject({
            kind: "maintenance-plan",
            value: { archived: 0, durableNoCandidates: true },
            ageFact: { entryCount: 2 },
          });
          if (initial.kind === "maintenance-plan") {
            expect(initial.nextAt).toBeGreaterThan(Date.now());
          }
          expect(await withinTest(scheduled.promise, signal)).toBeGreaterThan(1_000);
          expect(completedPlans).toBe(1);
        } else {
          if (overlap === "protection removal" && initial.kind === "maintenance-plan") {
            expect(initial.value).toMatchObject({ archived: 0, durableNoCandidates: true });
          }
          expect(await withinTest(scheduled.promise, signal)).toBe(1_000);
          const final = await withinTest(settled.promise, signal);
          expect(final.value.archived).toBe(1);
          const archivedKey = overlap === "new entry" ? newKey : lockedKey;
          expect(
            loadSessionEntry({ storePath, sessionKey: archivedKey })?.archivedAt,
          ).toBeDefined();
        }
        const preserved = overlap === "protection removal" ? [sessionKey] : [sessionKey, lockedKey];
        expect(
          preserved.map((key) => loadSessionEntry({ storePath, sessionKey: key })?.archivedAt),
        ).toEqual(preserved.map(() => undefined));
      } finally {
        await usage?.release();
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
        vi.restoreAllMocks();
      }
    });
  },
);
