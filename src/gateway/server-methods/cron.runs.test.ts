import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { cronRunLogEntryToDetail, cronRunStorageStatus } from "../../cron/run-history-detail.js";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { recordCronRunInDatabase } from "../../cron/store/run-history.kernel.js";
import type { CronRunHistoryWrite } from "../../cron/store/run-history.types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as sharingPreparation from "../session-sharing-preparation.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

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
      method?: "cron.runs" | "cron.list",
    ) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
    viewer: GatewayClient;
    owner: GatewayClient;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      ...rolePolicyConfig(),
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    const owner = roleClient("none", "history-owner");
    const foreign = roleClient("none", "history-foreign");
    const viewer = roleClient("view", "history-viewer");
    const ownKey = "agent:main:history-own";
    const foreignKey = "agent:main:history-foreign";
    for (const [sessionKey, client] of [
      [ownKey, owner],
      [foreignKey, foreign],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
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
      defaultAgentId: "main",
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
          agentId: "main",
          owner: { agentId: "main", sessionKey },
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
        Pick<CronRunLogEntry, "sessionKey" | "status" | "summary" | "jobId"> & { agentId?: string }
      > = [
        { jobId, sessionKey: foreignKey, status: "error", summary: "needle hidden" },
        { jobId, sessionKey: ownKey, status: "error", summary: "needle first" },
        { jobId, sessionKey: foreignKey, status: "ok", summary: "other hidden" },
        { jobId, status: "error", summary: "needle second" },
        { jobId, sessionKey: ownKey, status: "ok", summary: "other third" },
        { jobId: foreignJobId, sessionKey: ownKey, status: "error", summary: "needle foreign job" },
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
          agentId: row.agentId ?? "main",
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
      const query = async (
        params: Record<string, unknown>,
        client = owner,
        method: "cron.runs" | "cron.list" = "cron.runs",
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
    }
  });
}

describe("cron.runs session visibility", () => {
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

  it.each(["job", "all"] as const)(
    "paginates visible %s history before counting and slicing",
    async (scope) => {
      await withCronHistory(async ({ jobId, query }) => {
        const selector = scope === "job" ? { id: jobId } : { scope };
        for (const [offset, summary] of [
          "needle first",
          "needle second",
          "other third",
        ].entries()) {
          const respond = await query({
            ...selector,
            agentId: "MAIN",
            limit: 1,
            offset,
            sortDir: "asc",
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            {
              entries: [expect.objectContaining({ summary })],
              total: 3,
              offset,
              limit: 1,
              hasMore: offset < 2,
              nextOffset: offset < 2 ? offset + 1 : null,
            },
            undefined,
          );
        }
        expect(await query({ ...selector, offset: 99, limit: 1 })).toHaveBeenCalledWith(
          true,
          {
            entries: [],
            total: 3,
            offset: 3,
            limit: 1,
            hasMore: false,
            nextOffset: null,
          },
          undefined,
        );
      });
    },
  );

  it("uses current job names after an asynchronous history read", async () => {
    await withCronHistory(async ({ jobId, cron, query }) => {
      const list = cron.list.bind(cron);
      const listSpy = vi.spyOn(cron, "list").mockImplementationOnce(async (options) => {
        const jobs = await list(options);
        await cron.update(jobId, { name: "replacement-visible-name" });
        return jobs;
      });
      try {
        const respond = await query({ scope: "all", query: "replacement-visible-name" });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            total: 3,
            entries: expect.arrayContaining([
              expect.objectContaining({ jobName: "replacement-visible-name" }),
            ]),
          }),
          undefined,
        );
      } finally {
        listSpy.mockRestore();
      }
    });
  });

  it.each([
    { scope: "job", newlyMatches: true },
    { scope: "all", newlyMatches: true },
    { scope: "job", newlyMatches: false },
    { scope: "all", newlyMatches: false },
  ] as const)(
    "rechecks $scope history query after a rename during sharing preparation (new match: $newlyMatches)",
    async ({ scope, newlyMatches }) => {
      await withCronHistory(async ({ jobId, cron, query, owner, rows }) => {
        const firstKey = "agent:main:history-first-run";
        const laterKey = "agent:main:history-later-run";
        const profileId = expectDefined(owner.authenticatedUserProfile, "run owner").profileId;
        for (const sessionKey of [firstKey, laterKey]) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: sessionKey,
              updatedAt: Date.now(),
              createdActor: { type: "human", source: "profile", id: profileId },
            },
          );
        }
        runOpenClawStateWriteTransaction(({ db }) => {
          for (const [index, sessionKey] of [
            [1, firstKey],
            [4, laterKey],
          ] as const) {
            recordCronRunInDatabase(db, {
              ...expectDefined(rows[index], "fixture run"),
              sessionKey,
            });
          }
        });
        const name = newlyMatches ? "needle renamed job" : "renamed away";
        const prepare = sharingPreparation.prepareSessionMutationFacts;
        let renamed = false;
        const preparation = vi
          .spyOn(sharingPreparation, "prepareSessionMutationFacts")
          .mockImplementation(async (params) => {
            const read = await prepare(params);
            if (params.sessionKey === firstKey && !renamed) {
              renamed = true;
              await cron.update(jobId, { name });
            }
            return read;
          });
        try {
          const respond = await query({
            ...(scope === "job" ? { id: jobId } : { scope }),
            query: newlyMatches ? "needle" : "agent:main:history-own",
            sortDir: "asc",
          });
          expect(renamed).toBe(true);
          expect(cron.getJob(jobId)?.name).toBe(name);
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              total: newlyMatches ? 3 : 0,
              entries: newlyMatches
                ? [
                    expect.objectContaining({
                      runId: "history-run-1",
                      sessionKey: firstKey,
                      jobName: name,
                    }),
                    expect.objectContaining({ runId: "history-run-3", jobName: name }),
                    expect.objectContaining({
                      runId: "history-run-4",
                      sessionKey: laterKey,
                      jobName: name,
                    }),
                  ]
                : [],
            }),
            undefined,
          );
        } finally {
          preparation.mockRestore();
        }
      });
    },
  );

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
    { filter: { query: "absent text" }, total: 0, offset: 0 },
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
