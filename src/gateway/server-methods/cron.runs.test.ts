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
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import type { CronService } from "../../cron/service.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronRunHistoryWrite } from "../../cron/store/run-history.types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../../state/user-profiles-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import {
  callCron as invokeCron,
  createReadService,
  createHistoryJob,
  historyRecord,
  persistRuns,
} from "./cron-read.test-support.js";
import {
  createCronCallerClient,
  expectCronReply as expectReply,
  expectCronFailure as expectError,
} from "./cron.validation.test-support.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

function expectNotFound(respond: ReturnType<typeof vi.fn<RespondFn>>, jobId: string) {
  expectError(respond, expect.objectContaining({ details: { code: "CRON_JOB_NOT_FOUND", jobId } }));
}

function makeRun(
  jobId: string,
  runId: string,
  fields: Omit<Partial<CronRunLogEntry>, "runId"> = {},
): CronRunLogEntry & { runId: string } {
  return { action: "finished", jobId, runId, status: "ok", ts: Date.now(), ...fields };
}
function createOwnedSession(agentId: string, sessionKey: string, client: GatewayClient) {
  return upsertSessionEntryCore(
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

function expectVisibleRuns(respond: ReturnType<typeof vi.fn<RespondFn>>, runIds: string[]) {
  expectReply(
    respond,
    expect.objectContaining({
      total: runIds.length,
      entries: runIds.map((runId) => expect.objectContaining({ runId })),
    }),
  );
}

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;

async function withCronHistory(
  run: (fixture: {
    jobId: string;
    foreignJobId: string;
    cron: CronService;
    rows: CronRunHistoryWrite[];
    recordRun: (entry: CronRunLogEntry, suffix: string, agentId?: string) => void;
    storePath: string;
    query: (
      params: Record<string, unknown>,
      client?: GatewayClient,
      method?: "cron.runs" | "cron.list" | "cron.get",
    ) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
    viewer: GatewayClient;
    owner: GatewayClient;
  }) => Promise<void>,
  options: { unresolvedDefault?: boolean; agentId?: string; scheduled?: boolean } = {},
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
      await createOwnedSession(agentId, sessionKey, client);
    }
    const storePath = state.path("cron", "jobs.json");
    const cron = createReadService({
      storePath,
      resolveDefaultAgentId: () => (options.unresolvedDefault ? undefined : agentId),
      cronEnabled: false,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    try {
      const jobs = [];
      for (const sessionKey of [ownKey, foreignKey]) {
        const result = await cron.add(
          {
            ...createHistoryJob(agentId, sessionKey, sessionKey),
            ...(options.scheduled ? { owner: { agentId, sessionKey, accountId: "default" } } : {}),
          },
          options.scheduled
            ? {
                scheduledToolPolicy: {
                  version: 1,
                  mode: "account",
                  ownerSessionKey: sessionKey,
                  ownerAccountId: "default",
                },
              }
            : undefined,
        );
        jobs.push("job" in result ? result.job : result);
      }
      const jobId = expectDefined(jobs[0], "own job").id;
      const foreignJobId = expectDefined(jobs[1], "foreign job").id;
      const now = Date.now();
      const records = (
        [
          [foreignKey, "error", "needle hidden"],
          [ownKey, "error", "needle first"],
          [foreignKey, "ok", "other hidden"],
          [undefined, "error", "needle second"],
          [ownKey, "ok", "other third"],
          [ownKey, "error", "needle foreign job", foreignJobId],
        ] as const
      ).map(([sessionKey, status, summary, id = jobId], index) =>
        historyRecord(
          makeRun(id, `history-run-${index}`, {
            sessionKey,
            status,
            summary,
            ts: now + index,
            deliveryStatus: status === "error" ? "not-delivered" : "delivered",
          }),
          storePath,
          agentId,
          `cron:${id}:${now + index}:history`,
        ),
      );
      persistRuns(records);
      const context = createDirectChatContext({
        cron,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
      });
      await initializeSessionReadContext(context);
      const query = (
        params: Record<string, unknown>,
        client = owner,
        method: "cron.runs" | "cron.list" | "cron.get" = "cron.runs",
      ) => invokeCron(context, method, params, { client });
      const recordRun = (entry: CronRunLogEntry, suffix: string, runAgentId = agentId) =>
        persistRuns([
          historyRecord(entry, storePath, runAgentId, `cron:${entry.jobId}:${entry.ts}:${suffix}`),
        ]);
      await run({
        jobId,
        foreignJobId,
        cron,
        query,
        viewer,
        owner,
        rows: records,
        storePath,
        recordRun,
      });
    } finally {
      cron.stop();
      await disposeSessionReadContexts();
    }
  });
}

describe("cron.runs session visibility", () => {
  it("lets an admitted job read its receipts across delivery accounts, but no other job", async () => {
    await withCronHistory(
      async ({ jobId, foreignJobId, query, owner }) => {
        const client = {
          ...owner,
          internal: createCronCallerClient(
            "main",
            "delivery-account",
            "agent:main:resumed-turn",
            jobId,
          ).internal,
        };
        expectReply(
          await query({ id: jobId, limit: 2 }, client),
          expect.objectContaining({
            total: 5,
            entries: [
              expect.objectContaining({ runId: "history-run-4", deliveryStatus: "delivered" }),
              expect.objectContaining({ runId: "history-run-3", deliveryStatus: "not-delivered" }),
            ],
          }),
        );
        expectNotFound(await query({ id: foreignJobId }, client), foreignJobId);
        client.internal!.agentRuntimeIdentity!.cronSelfManagementContext!.expiresAtMs =
          Date.now() - 1;
        expectNotFound(await query({ id: jobId }, client), jobId);
      },
      { scheduled: true },
    );
  });

  it.each([true, false])(
    "keeps retained deleted-main visibility ahead of replacement-agent aliases (visible: %s)",
    (visible) =>
      withCronHistory(
        async ({ jobId, query, owner, viewer, recordRun }) => {
          await createOwnedSession("main", "agent:main:main", visible ? owner : viewer);
          await createOwnedSession("research", "agent:research:main", visible ? viewer : owner);
          const entry = makeRun(jobId, "retained-main-run", {
            sessionKey: "agent:main:main",
            summary: "Retained run before the job changed agents",
          });
          recordRun(entry, "retained-main", "main");
          const params = { id: jobId, runId: entry.runId };
          expectVisibleRuns(await query(params), visible ? [entry.runId] : []);
        },
        { agentId: "research" },
      ),
  );

  it("searches full run details before paging summary views without changing visibility", () =>
    withCronHistory(async ({ jobId, foreignJobId, query, storePath }) => {
      const entries: CronRunLogEntry[] = (
        [
          [jobId, "agent:main:history-foreign", "not-delivered"],
          [jobId, "agent:main:history-own", "not-delivered"],
          [jobId, "agent:main:history-own", "unknown"],
          [foreignJobId, "agent:main:history-own", "not-delivered"],
        ] as const
      ).map(([entryJobId, sessionKey, deliveryStatus], index) => ({
        jobId: entryJobId,
        sessionKey,
        deliveryStatus,
        action: "finished",
        ts: 100 + index,
        runId: `delivery-search-${index}`,
        status: "ok",
        completionStatus: deliveryStatus === "unknown" ? "unknown" : "failed",
        summary: "Report completed",
        deliveryError: "Synthetic recipient unavailable",
        sessionId: `delivery-session-${index}`,
        diagnostics: { summary: "Diagnostic-only search", entries: [] },
        delivery: { intended: { channel: "synthetic-channel" } },
        failureNotificationDelivery: { status: "not-delivered", error: "Notification failed" },
      }));
      persistRuns(
        entries.map((entry) =>
          historyRecord(
            entry,
            storePath,
            "main",
            `cron:${entry.jobId}:${entry.ts}:delivery-search`,
          ),
        ),
      );
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
            expectReply(respond, {
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
            });
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
    }));

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
    ({ sessionTarget, agentId, explicitOwner, sqlOwner }) =>
      withCronHistory(
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
          runOpenClawStateWriteTransaction(({ db }) => {
            if (sqlOwner) {
              db.prepare(
                "UPDATE cron_jobs SET agent_id = ? WHERE store_key = ? AND job_id = ?",
              ).run(sqlOwner, cronStoreKey(storePath), jobId);
            }
          });
          const targetKey = sessionTarget === "main" ? "main" : "custom-target";
          await createOwnedSession(agentId, targetKey, owner);
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
              expectReply(inspected, expect.any(Object));
            } else {
              expectError(inspected, expect.any(Object));
              expectReply(await query({ id: jobId }, viewer, method), expect.any(Object));
            }
            expectError(
              await query({ id: jobId }, roleClient("none", "visibility-foreign"), method),
              expect.any(Object),
            );
          }
          if (!explicitOwner) {
            const list = (client: GatewayClient) =>
              query({ includeDisabled: true, includeDeliveryPreviews: false }, client, "cron.list");
            expectReply(await list(owner), expect.objectContaining({ jobs: [] }));
            expectReply(
              await list(viewer),
              expect.objectContaining({
                jobs: expect.arrayContaining([expect.objectContaining({ id: jobId })]),
              }),
            );
          }
        },
        { unresolvedDefault: true },
      ),
  );
  it.each(["cron.list", "cron.runs"] as const)(
    "%s filters jobs before preparing unavailable foreign sessions",
    (method) =>
      withCronHistory(async ({ cron, query, jobId, foreignJobId, recordRun }) => {
        const unavailable = await cron.add(
          createHistoryJob("broken", "agent:broken:creator", "Unavailable foreign job"),
        );
        const agentDir = path.dirname(
          path.dirname(resolveSessionStorePathCore(undefined, { agentId: "broken" })),
        );
        fs.mkdirSync(path.dirname(agentDir), { recursive: true });
        fs.writeFileSync(agentDir, "unavailable agent directory\n");
        expectReply(
          await query(
            {
              agentId: "MAIN",
              ...(method === "cron.list" ? { includeDisabled: true } : { scope: "all" }),
            },
            undefined,
            method,
          ),
          expect.objectContaining({ total: method === "cron.list" ? 1 : 3 }),
        );
        if (method === "cron.list") {
          expectReply(
            await query(
              { includeDisabled: true, query: "agent:main:history-own" },
              undefined,
              method,
            ),
            expect.objectContaining({ total: 1 }),
          );
          expectReply(
            await query(
              { includeDisabled: true, sessionKey: `agent:main:cron:${jobId}` },
              undefined,
              method,
            ),
            expect.objectContaining({ total: 1 }),
          );
        } else {
          const unavailableId = "job" in unavailable ? unavailable.job.id : unavailable.id;
          expectNotFound(await query({ id: unavailableId, agentId: "main" }), unavailableId);
          await cron.remove(unavailableId);
          const historicalEntry = makeRun(jobId, "historical-ops-run", {
            summary: "run before the job changed agents",
          });
          recordRun(historicalEntry, "historical-ops-run", "ops");
          for (const [selector, total] of [
            [{ scope: "all" }, 1],
            [{ scope: "all", agentId: "MAIN" }, 0],
            [{ id: jobId, agentId: "MAIN" }, 1],
          ] as const) {
            expectVisibleRuns(
              await query({ ...selector, runId: historicalEntry.runId }),
              total === 0 ? [] : [historicalEntry.runId],
            );
          }
          for (const [id, runId] of [
            [foreignJobId, "hidden-unavailable"],
            [jobId, "filtered-unavailable"],
          ] as const) {
            const entry = makeRun(id, runId, {
              sessionKey: `agent:broken:${runId}`,
              status: "error",
            });
            recordRun(entry, runId, "broken");
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
            expectReply(result.value, expect.objectContaining({ total: index < 2 ? 1 : 0 }));
          }
        }
      }),
  );

  it("refreshes run and job visibility after session creation and deletion", () =>
    withCronHistory(async ({ jobId, query, owner, rows, recordRun }) => {
      const sessionKey = "agent:main:history-created";
      const entry = makeRun(jobId, "created-session-run", {
        sessionKey,
        ts: Math.max(...rows.map((row) => row.endedAt ?? row.startedAt)) + 1,
      });
      recordRun(entry, "created-session");
      const params = { id: jobId, sortDir: "asc" };
      expectVisibleRuns(await query(params), ["history-run-1", "history-run-3", "history-run-4"]);
      await createOwnedSession("main", sessionKey, owner);
      expectVisibleRuns(await query(params), [
        "history-run-1",
        "history-run-3",
        "history-run-4",
        entry.runId,
      ]);
      const deleteSession = (key: string) =>
        deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          target: { canonicalKey: key, storeKeys: [key] },
          archiveTranscript: false,
        });
      expect((await deleteSession(sessionKey)).deleted).toBe(true);
      expectVisibleRuns(await query(params), ["history-run-1", "history-run-3", "history-run-4"]);
      expect((await deleteSession("agent:main:history-own")).deleted).toBe(true);
      expectNotFound(await query(params), jobId);
    }));

  it.each(["job", "all"] as const)("combines %s visibility with history filters", (scope) =>
    withCronHistory(async ({ jobId, query }) => {
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
      expectReply(respond, {
        entries: [expect.objectContaining({ summary: "needle second" })],
        total: 2,
        offset: 1,
        limit: 1,
        hasMore: false,
        nextOffset: null,
      });
    }),
  );

  it.each([
    { filter: { runId: "absent-run" }, total: 0, offset: 0 },
    { filter: { runId: "history-run-1", offset: 99 }, total: 1, offset: 1 },
  ])(
    "keeps deleted-job empty pages distinct from missing history: $filter",
    ({ filter, total, offset }) =>
      withCronHistory(async ({ jobId, foreignJobId, cron, query, viewer }) => {
        expectNotFound(await query({ id: foreignJobId }), foreignJobId);
        await cron.remove(jobId);
        expectNotFound(await query({ id: jobId }), jobId);
        expectReply(
          await query({ id: jobId, limit: 1, runId: "history-run-1" }, viewer),
          expect.objectContaining({
            entries: [expect.objectContaining({ summary: "needle first" })],
            total: 1,
          }),
        );
        expectReply(await query({ id: jobId, ...filter, limit: 1 }, viewer), {
          entries: [],
          total,
          offset,
          limit: 1,
          hasMore: false,
          nextOffset: null,
        });
        expectNotFound(
          await query({ id: "missing-job", ...filter, limit: 1 }, viewer),
          "missing-job",
        );
      }),
  );
});
