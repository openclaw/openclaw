import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { cronRunLogEntryToDetail, cronRunStorageStatus } from "../../cron/run-history-detail.js";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { recordCronRunInDatabase } from "../../cron/store/run-history.kernel.js";
import type { CronRunHistoryWrite } from "../../cron/store/run-history.types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../../state/user-profiles-schema.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { cronHandlers } from "./cron.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;

async function withCronHistory(
  run: (fixture: {
    jobId: string;
    foreignJobId: string;
    cron: CronService;
    rows: CronRunHistoryWrite[];
    storePath: string;
    query: (
      params: Record<string, unknown>,
      client?: GatewayClient,
      method?: "cron.runs" | "cron.list" | "cron.get",
    ) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
    viewer: GatewayClient;
    owner: GatewayClient;
  }) => Promise<void>,
  options: { unresolvedDefault?: boolean; agentId?: string } = {},
) {
  await withOpenClawTestState(profileState, async (state) => {
    const agentId = options.agentId ?? "main";
    const cfg = {
      ...rolePolicyConfig(),
      agents: {
        entries: {
          [agentId]: { workspace: state.workspaceDir },
          ...(options.unresolvedDefault ? { ops: {} } : {}),
        },
        ...(options.unresolvedDefault ? { ownership: "explicit" as const } : {}),
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    ensureUserProfilesSchema({});
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const owner = roleClient("none", "history-owner");
    const foreign = roleClient("none", "history-foreign");
    const viewer = roleClient("view", "history-viewer");
    const ownKey = `agent:${agentId}:history-own`;
    const foreignKey = `agent:${agentId}:history-foreign`;
    for (const [sessionKey, client] of [
      [ownKey, owner],
      [foreignKey, foreign],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: Date.now(),
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(client.authenticatedUserProfile, "fixture profile").profileId,
          },
        },
      );
    }
    const storePath = state.path("cron", "jobs.json");
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      resolveDefaultAgentId: () => (options.unresolvedDefault ? undefined : agentId),
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    try {
      const jobs = [];
      for (const sessionKey of [ownKey, foreignKey]) {
        const result = await cron.add({
          name: sessionKey,
          agentId,
          owner: { agentId, sessionKey },
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "fixture" },
          delivery: { mode: "none" },
        });
        jobs.push("job" in result ? result.job : result);
      }
      const jobId = expectDefined(jobs[0], "own job").id;
      const foreignJobId = expectDefined(jobs[1], "foreign job").id;
      const rows: Array<
        Pick<CronRunLogEntry, "sessionKey" | "status" | "summary" | "jobId"> & {
          agentId?: string;
        }
      > = [
        { jobId, sessionKey: foreignKey, status: "error", summary: "needle hidden" },
        { jobId, sessionKey: ownKey, status: "error", summary: "needle first" },
        { jobId, sessionKey: foreignKey, status: "ok", summary: "other hidden" },
        { jobId, status: "error", summary: "needle second" },
        { jobId, sessionKey: ownKey, status: "ok", summary: "other third" },
        {
          jobId: foreignJobId,
          sessionKey: ownKey,
          status: "error",
          summary: "needle foreign job",
        },
      ];
      const now = Date.now();
      const storeKey = cronStoreKey(storePath);
      const records = rows.map((row, index): CronRunHistoryWrite => {
        const entry: CronRunLogEntry = {
          ...row,
          action: "finished",
          ts: now + index,
          runId: `history-run-${index}`,
          deliveryStatus: row.status === "error" ? "not-delivered" : "delivered",
        };
        return {
          storeKey,
          jobId: entry.jobId,
          runId: `cron:${entry.jobId}:${entry.ts}:history`,
          agentId: row.agentId ?? agentId,
          sessionKey: entry.sessionKey,
          startedAt: entry.ts,
          endedAt: entry.ts,
          status: cronRunStorageStatus(entry),
          summary: entry.summary,
          detail: cronRunLogEntryToDetail(entry, { storeKey }),
        };
      });
      runOpenClawStateWriteTransaction(({ db }) => {
        for (const record of records) {
          recordCronRunInDatabase(db, record);
        }
      });
      const context = createDirectChatContext({
        cron,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
      });
      await initializeSessionReadContext(context);
      const query = async (
        params: Record<string, unknown>,
        client = owner,
        method: "cron.runs" | "cron.list" | "cron.get" = "cron.runs",
      ) => {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          cronHandlers[method],
          `${method} handler`,
        )({
          req: { type: "req", id: "history-request", method, params },
          params,
          client,
          respond,
          context,
          isWebchatConnect: () => false,
        });
        return respond;
      };
      await run({ jobId, foreignJobId, cron, query, viewer, owner, rows: records, storePath });
    } finally {
      cron.stop();
      await disposeSessionReadContexts();
    }
  });
}

describe("cron.runs session visibility", () => {
  it.each([true, false])(
    "keeps retained deleted-main visibility ahead of replacement-agent aliases (visible: %s)",
    async (visible) => {
      await withCronHistory(
        async ({ jobId, query, owner, viewer, rows, storePath }) => {
          const createSession = (agentId: string, client: GatewayClient) =>
            upsertSessionEntryCore(
              { agentId, sessionKey: `agent:${agentId}:main` },
              {
                sessionId: `${agentId}-main`,
                updatedAt: Date.now(),
                createdActor: {
                  type: "human",
                  source: "profile",
                  id: expectDefined(client.authenticatedUserProfile, "fixture profile").profileId,
                },
              },
            );
          await createSession("main", visible ? owner : viewer);
          await createSession("research", visible ? viewer : owner);
          const storeKey = cronStoreKey(storePath);
          const entry: CronRunLogEntry = {
            action: "finished",
            jobId,
            runId: "retained-main-run",
            sessionKey: "agent:main:main",
            status: "ok",
            summary: "Retained run before the job changed agents",
            ts: Date.now(),
          };
          runOpenClawStateWriteTransaction(({ db }) => {
            recordCronRunInDatabase(db, {
              ...expectDefined(rows[0], "fixture run"),
              runId: `cron:${jobId}:${entry.ts}:retained-main`,
              agentId: "main",
              sessionKey: entry.sessionKey,
              startedAt: entry.ts,
              endedAt: entry.ts,
              status: cronRunStorageStatus(entry),
              summary: entry.summary,
              detail: cronRunLogEntryToDetail(entry, { storeKey }),
            });
          });
          const params = { id: jobId, runId: entry.runId };
          expect(await query(params)).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              total: visible ? 1 : 0,
              entries: visible ? [expect.objectContaining({ runId: entry.runId })] : [],
            }),
            undefined,
          );
        },
        { agentId: "research" },
      );
    },
  );

  it("searches full run details before paging summary views without changing visibility", async () => {
    await withCronHistory(async ({ jobId, foreignJobId, query, rows, storePath }) => {
      const storeKey = cronStoreKey(storePath);
      const template = expectDefined(rows[0], "fixture run");
      const targets: Pick<CronRunLogEntry, "jobId" | "sessionKey" | "deliveryStatus">[] = [
        { jobId, sessionKey: "agent:main:history-foreign", deliveryStatus: "not-delivered" },
        { jobId, sessionKey: "agent:main:history-own", deliveryStatus: "not-delivered" },
        { jobId, sessionKey: "agent:main:history-own", deliveryStatus: "unknown" },
        {
          jobId: foreignJobId,
          sessionKey: "agent:main:history-own",
          deliveryStatus: "not-delivered",
        },
      ];
      const entries: CronRunLogEntry[] = targets.map((row, index) => ({
        jobId: row.jobId,
        sessionKey: row.sessionKey,
        deliveryStatus: row.deliveryStatus,
        action: "finished",
        ts: 100 + index,
        runId: `delivery-search-${index}`,
        status: "ok",
        completionStatus: row.deliveryStatus === "unknown" ? "unknown" : "failed",
        summary: "Report completed",
        deliveryError: "Synthetic recipient unavailable",
        sessionId: `delivery-session-${index}`,
        diagnostics: { summary: "Diagnostic-only search", entries: [] },
        delivery: { intended: { channel: "synthetic-channel" } },
        failureNotificationDelivery: { status: "not-delivered", error: "Notification failed" },
      }));
      runOpenClawStateWriteTransaction(({ db }) => {
        for (const entry of entries) {
          recordCronRunInDatabase(db, {
            ...template,
            jobId: entry.jobId,
            sessionKey: entry.sessionKey,
            runId: `cron:${entry.jobId}:${entry.ts}:delivery-search`,
            startedAt: entry.ts,
            endedAt: entry.ts,
            status: cronRunStorageStatus(entry),
            summary: entry.summary,
            detail: cronRunLogEntryToDetail(entry, { storeKey }),
          });
        }
      });
      for (const scope of ["job", "all"] as const) {
        for (const view of ["summary", undefined] as const) {
          for (const search of ["RECIPIENT unavailable", "diagnostic-only", "synthetic-channel"]) {
            const respond = await query({
              ...(scope === "job" ? { id: jobId } : { scope }),
              ...(view ? { view } : {}),
              query: search,
              sortDir: "asc",
              offset: 1,
              limit: 1,
            });
            expect(respond).toHaveBeenCalledWith(
              true,
              {
                entries: [
                  expect.objectContaining({
                    runId: "delivery-search-2",
                    sessionId: "delivery-session-2",
                    summary: "Report completed",
                    deliveryStatus: "unknown",
                    deliveryError: "Synthetic recipient unavailable",
                  }),
                ],
                total: 2,
                offset: 1,
                limit: 1,
                hasMore: false,
                nextOffset: null,
              },
              undefined,
            );
            const page = respond.mock.calls[0]?.[1];
            for (const field of ["diagnostics", "delivery", "failureNotificationDelivery"]) {
              if (view === "summary") {
                expect(page).not.toHaveProperty(`entries.0.${field}`);
              } else {
                expect(page).toHaveProperty(`entries.0.${field}`);
              }
            }
          }
        }
      }
    });
  });

  it.each([
    {
      sessionTarget: "session:custom-target",
      agentId: "main",
      explicitOwner: true,
      sqlOwner: null,
    },
    { sessionTarget: "main", agentId: "ops", explicitOwner: false, sqlOwner: null },
    { sessionTarget: "main", agentId: "ops", explicitOwner: false, sqlOwner: "main" },
  ] as const)(
    "uses canonical sharing for $sessionTarget without a fleet default (explicit=$explicitOwner, SQL owner=$sqlOwner)",
    async ({ sessionTarget, agentId, explicitOwner, sqlOwner }) => {
      await withCronHistory(
        async ({ cron, query, jobId, storePath, owner, viewer }) => {
          const store = await loadCronStore(storePath);
          const job = expectDefined(
            store.jobs.find((entry) => entry.id === jobId),
            "fixture job",
          );
          job.sessionKey = explicitOwner
            ? expectDefined(job.owner?.sessionKey, "authored session owner")
            : "main";
          delete job.agentId;
          delete job.owner;
          job.sessionTarget = sessionTarget;
          if (sessionTarget === "main") {
            job.payload = { kind: "systemEvent", text: "visibility fixture" };
          }
          await saveCronStore(storePath, store);
          const persisted = runOpenClawStateWriteTransaction(({ db }) => {
            if (sqlOwner) {
              db.prepare(
                "UPDATE cron_jobs SET agent_id = ? WHERE store_key = ? AND job_id = ?",
              ).run(sqlOwner, cronStoreKey(storePath), jobId);
            }
            return db
              .prepare(
                "SELECT agent_id, job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?",
              )
              .get(cronStoreKey(storePath), jobId);
          });
          if (!explicitOwner) {
            if (typeof persisted?.job_json !== "string") {
              throw new Error("Expected persisted cron definition JSON");
            }
            const definition = JSON.parse(persisted.job_json);
            expect(definition).toMatchObject({ sessionKey: "main" });
            expect(definition).not.toHaveProperty("agentId");
            expect(definition).not.toHaveProperty("owner");
            expect(persisted.agent_id).toBe(sqlOwner);
          }
          const targetKey = sessionTarget === "main" ? "main" : "custom-target";
          await upsertSessionEntryCore(
            { agentId, sessionKey: targetKey },
            {
              sessionId: `visibility-${targetKey}`,
              updatedAt: Date.now(),
              createdActor: {
                type: "human",
                source: "profile",
                id: expectDefined(owner.authenticatedUserProfile, "fixture profile").profileId,
              },
            },
          );
          const loaded = await cron.readJob(jobId);
          expect(loaded).toMatchObject({
            sessionKey: job.sessionKey,
            sessionTarget,
          });
          if (!explicitOwner) {
            expect(loaded?.agentId).toBeUndefined();
            expect(loaded?.owner).toBeUndefined();
          }
          for (const method of ["cron.get", "cron.runs"] as const) {
            const inspected = await query({ id: jobId }, owner, method);
            if (explicitOwner) {
              expect(inspected).toHaveBeenCalledWith(true, expect.any(Object), undefined);
            } else {
              expect(inspected).toHaveBeenCalledWith(false, undefined, expect.any(Object));
              expect(await query({ id: jobId }, viewer, method)).toHaveBeenCalledWith(
                true,
                expect.any(Object),
                undefined,
              );
            }
            expect(
              await query({ id: jobId }, roleClient("none", "visibility-foreign"), method),
            ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
          }
          if (!explicitOwner) {
            expect(
              await query(
                { includeDisabled: true, includeDeliveryPreviews: false },
                owner,
                "cron.list",
              ),
            ).toHaveBeenCalledWith(true, expect.objectContaining({ jobs: [] }), undefined);
            expect(
              await query(
                { includeDisabled: true, includeDeliveryPreviews: false },
                viewer,
                "cron.list",
              ),
            ).toHaveBeenCalledWith(
              true,
              expect.objectContaining({
                jobs: expect.arrayContaining([expect.objectContaining({ id: jobId })]),
              }),
              undefined,
            );
          }
        },
        { unresolvedDefault: true },
      );
    },
  );
  it.each(["cron.list", "cron.runs"] as const)(
    "%s filters jobs before preparing unavailable foreign sessions",
    async (method) => {
      await withCronHistory(async ({ cron, query, jobId, foreignJobId, rows, storePath }) => {
        const unavailable = await cron.add({
          name: "Unavailable foreign job",
          agentId: "broken",
          owner: { agentId: "broken", sessionKey: "agent:broken:creator" },
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "fixture" },
          delivery: { mode: "none" },
        });
        const agentDir = path.dirname(
          path.dirname(resolveSessionStorePathCore(undefined, { agentId: "broken" })),
        );
        fs.mkdirSync(path.dirname(agentDir), { recursive: true });
        fs.writeFileSync(agentDir, "unavailable agent directory\n");
        expect(
          await query(
            {
              agentId: "MAIN",
              ...(method === "cron.list" ? { includeDisabled: true } : { scope: "all" }),
            },
            undefined,
            method,
          ),
        ).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ total: method === "cron.list" ? 1 : 3 }),
          undefined,
        );
        if (method === "cron.list") {
          expect(
            await query(
              { includeDisabled: true, query: "agent:main:history-own" },
              undefined,
              method,
            ),
          ).toHaveBeenCalledWith(true, expect.objectContaining({ total: 1 }), undefined);
          expect(
            await query(
              { includeDisabled: true, sessionKey: `agent:main:cron:${jobId}` },
              undefined,
              method,
            ),
          ).toHaveBeenCalledWith(true, expect.objectContaining({ total: 1 }), undefined);
        } else {
          const unavailableId = "job" in unavailable ? unavailable.job.id : unavailable.id;
          expect(await query({ id: unavailableId, agentId: "main" })).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              details: { code: "CRON_JOB_NOT_FOUND", jobId: unavailableId },
            }),
          );
          await cron.remove(unavailableId);
          const historicalEntry: CronRunLogEntry = {
            action: "finished",
            jobId,
            runId: "historical-ops-run",
            status: "ok",
            summary: "run before the job changed agents",
            ts: Date.now(),
          };
          runOpenClawStateWriteTransaction(({ db }) => {
            recordCronRunInDatabase(db, {
              ...expectDefined(rows[0], "fixture run"),
              jobId,
              runId: `cron:${jobId}:${historicalEntry.ts}:historical-ops-run`,
              agentId: "ops",
              sessionKey: undefined,
              startedAt: historicalEntry.ts,
              endedAt: historicalEntry.ts,
              status: cronRunStorageStatus(historicalEntry),
              summary: historicalEntry.summary,
              detail: cronRunLogEntryToDetail(historicalEntry, {
                storeKey: cronStoreKey(storePath),
              }),
            });
          });
          for (const [selector, total] of [
            [{ scope: "all" }, 1],
            [{ scope: "all", agentId: "MAIN" }, 0],
            [{ id: jobId, agentId: "MAIN" }, 1],
          ] as const) {
            expect(await query({ ...selector, runId: historicalEntry.runId })).toHaveBeenCalledWith(
              true,
              expect.objectContaining({
                total,
                entries:
                  total === 0 ? [] : [expect.objectContaining({ runId: "historical-ops-run" })],
              }),
              undefined,
            );
          }
          for (const [id, runId] of [
            [foreignJobId, "hidden-unavailable"],
            [jobId, "filtered-unavailable"],
          ] as const) {
            const entry: CronRunLogEntry = {
              action: "finished",
              jobId: id,
              runId,
              sessionKey: `agent:broken:${runId}`,
              status: "error",
              ts: Date.now(),
            };
            runOpenClawStateWriteTransaction(({ db }) => {
              recordCronRunInDatabase(db, {
                ...expectDefined(rows[0], "fixture run"),
                jobId: entry.jobId,
                runId: `cron:${entry.jobId}:${entry.ts}:${runId}`,
                agentId: "broken",
                sessionKey: entry.sessionKey,
                startedAt: entry.ts,
                endedAt: entry.ts,
                status: cronRunStorageStatus(entry),
                summary: entry.summary,
                detail: cronRunLogEntryToDetail(entry, { storeKey: cronStoreKey(storePath) }),
              });
            });
          }
          const selected = await Promise.allSettled([
            query({ scope: "all", runId: "history-run-1" }),
            query({ id: jobId, runId: "history-run-1" }),
            query({ scope: "all", runId: "hidden-unavailable" }),
          ]);
          for (const [index, result] of selected.entries()) {
            if (result.status === "rejected") {
              throw result.reason;
            }
            expect(result.value).toHaveBeenCalledWith(
              true,
              expect.objectContaining({ total: index < 2 ? 1 : 0 }),
              undefined,
            );
          }
        }
      });
    },
  );

  it("refreshes run and job visibility after session creation and deletion", async () => {
    await withCronHistory(async ({ jobId, query, owner, rows, storePath }) => {
      const sessionKey = "agent:main:history-created";
      const storeKey = cronStoreKey(storePath);
      const entry: CronRunLogEntry = {
        action: "finished",
        jobId,
        runId: "created-session-run",
        sessionKey,
        status: "ok",
        ts: Math.max(...rows.map((row) => row.endedAt ?? row.startedAt)) + 1,
      };
      runOpenClawStateWriteTransaction(({ db }) => {
        recordCronRunInDatabase(db, {
          ...expectDefined(rows[0], "fixture run"),
          runId: `cron:${jobId}:${entry.ts}:created-session`,
          sessionKey,
          startedAt: entry.ts,
          endedAt: entry.ts,
          status: cronRunStorageStatus(entry),
          summary: entry.summary,
          detail: cronRunLogEntryToDetail(entry, { storeKey }),
        });
      });
      const params = { id: jobId, sortDir: "asc" };
      expect(await query(params)).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          total: 3,
          entries: [
            expect.objectContaining({ runId: "history-run-1" }),
            expect.objectContaining({ runId: "history-run-3" }),
            expect.objectContaining({ runId: "history-run-4" }),
          ],
        }),
        undefined,
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "created-run-session",
          updatedAt: Date.now(),
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(owner.authenticatedUserProfile, "run owner").profileId,
          },
        },
      );
      expect(await query(params)).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          total: 4,
          entries: [
            expect.objectContaining({ runId: "history-run-1" }),
            expect.objectContaining({ runId: "history-run-3" }),
            expect.objectContaining({ runId: "history-run-4" }),
            expect.objectContaining({ runId: entry.runId }),
          ],
        }),
        undefined,
      );
      const deleteSession = (key: string) =>
        deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          target: { canonicalKey: key, storeKeys: [key] },
          archiveTranscript: false,
        });
      expect((await deleteSession(sessionKey)).deleted).toBe(true);
      expect(await query(params)).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          total: 3,
          entries: [
            expect.objectContaining({ runId: "history-run-1" }),
            expect.objectContaining({ runId: "history-run-3" }),
            expect.objectContaining({ runId: "history-run-4" }),
          ],
        }),
        undefined,
      );
      expect((await deleteSession("agent:main:history-own")).deleted).toBe(true);
      expect(await query(params)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "CRON_JOB_NOT_FOUND", jobId } }),
      );
    });
  });

  it.each(["job", "all"] as const)("combines %s visibility with history filters", async (scope) => {
    await withCronHistory(async ({ jobId, query }) => {
      const respond = await query({
        ...(scope === "job" ? { id: jobId } : { scope }),
        agentId: "MAIN",
        statuses: ["error"],
        status: "ok",
        deliveryStatuses: ["not-delivered"],
        deliveryStatus: "delivered",
        query: "needle",
        sortDir: "asc",
        offset: 1,
        limit: 1,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          entries: [expect.objectContaining({ summary: "needle second" })],
          total: 2,
          offset: 1,
          limit: 1,
          hasMore: false,
          nextOffset: null,
        },
        undefined,
      );
    });
  });

  it.each([
    { filter: { runId: "absent-run" }, total: 0, offset: 0 },
    { filter: { runId: "history-run-1", offset: 99 }, total: 1, offset: 1 },
  ])(
    "keeps deleted-job empty pages distinct from missing history: $filter",
    async ({ filter, total, offset }) => {
      await withCronHistory(async ({ jobId, cron, query, viewer }) => {
        await cron.remove(jobId);
        expect(await query({ id: jobId, ...filter, limit: 1 }, viewer)).toHaveBeenCalledWith(
          true,
          { entries: [], total, offset, limit: 1, hasMore: false, nextOffset: null },
          undefined,
        );
        expect(
          await query({ id: "missing-job", ...filter, limit: 1 }, viewer),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
          }),
        );
      });
    },
  );

  it("keeps foreign jobs hidden and retained deleted-job history available to viewers", async () => {
    await withCronHistory(async ({ jobId, foreignJobId, cron, query, viewer }) => {
      expect(await query({ id: foreignJobId })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "CRON_JOB_NOT_FOUND", jobId: foreignJobId } }),
      );
      await cron.remove(jobId);
      expect(await query({ id: jobId })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "CRON_JOB_NOT_FOUND", jobId } }),
      );
      expect(
        await query({ id: jobId, limit: 1, runId: "history-run-1" }, viewer),
      ).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          entries: [expect.objectContaining({ summary: "needle first" })],
          total: 1,
        }),
        undefined,
      );
    });
  });
});
