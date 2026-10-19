import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as listRevision from "../../cron/list-snapshot-revision.js";
import type { CronService } from "../../cron/service.js";
import * as cronSort from "../../cron/service/list-page-sort.js";
import type { CronListPageResult } from "../../cron/service/list-page-types.js";
import { loadCronQuarantinedJobs, loadCronStore, saveCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import { callCron, createReadService } from "./cron-read.test-support.js";
import { createCronCallerClient, createCronJob } from "./cron.validation.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(() => vi.restoreAllMocks());

function expectReply(respond: ReturnType<typeof vi.fn>, payload: unknown) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, payload, undefined);
}
function expectError(respond: ReturnType<typeof vi.fn>, error: unknown) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, error);
}

function createJobs(count: number): CronJob[] {
  return Array.from({ length: count }, (_, index) =>
    createCronJob({
      id: `job-${String(index).padStart(4, "0")}`,
      name: `Job ${String(index).padStart(4, "0")}`,
      agentId: index % 200 === 0 ? "ops" : "other",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      payload: { kind: "agentTurn", message: "scheduled check" },
    }),
  );
}

async function withCronStore(
  count: number,
  run: (fixture: {
    context: GatewayRequestContext;
    storePath: string;
    cron: CronService;
  }) => Promise<void>,
  options: {
    config?: OpenClawConfig;
    defaultAgentId?: string;
    jobs?: CronJob[];
  } = {},
) {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const storePath = path.join(state.root, "jobs.json");
    await saveCronStore(storePath, { version: 1, jobs: options.jobs ?? createJobs(count) });
    const cron = createReadService({
      storePath,
      cronEnabled: true,
      defaultAgentId: options.defaultAgentId ?? "main",
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    try {
      // Listing loads the real store without starting the scheduler.
      await withLocalGatewayRequestScope(
        { deps: {}, getRuntimeConfig: () => options.config ?? {} },
        async () => {
          const context = expectDefined(
            getPluginRuntimeGatewayRequestScope()?.context,
            "local Gateway context",
          );
          await run({ context: { ...context, cron, cronStorePath: storePath }, storePath, cron });
        },
      );
    } finally {
      cron.stop();
    }
  });
}

async function listScoped(
  context: GatewayRequestContext,
  offset = 0,
  sessionKey?: string,
  client: GatewayClient | null = createCronCallerClient("ops"),
) {
  const respond = await callCron(
    context,
    "cron.list",
    {
      includeDisabled: true,
      includeDeliveryPreviews: false,
      ...(sessionKey ? { sessionKey, sessionAgentId: "ops" } : {}),
      sortBy: "name",
      limit: 1,
      offset,
    },
    { client },
  );
  expectReply(respond, expect.any(Object));
  return respond.mock.calls[0]![1] as CronListPageResult;
}

describe("cron.list scoped SQLite snapshots", () => {
  it("lists 146 jobs with delivery previews through the real session worker", async () => {
    const cfg: OpenClawConfig = {};
    const jobs = createJobs(146).map((job, index) =>
      Object.assign(job, {
        agentId: "main",
        sessionKey: `agent:main:preview-${index}`,
        delivery: { mode: "announce" as const, channel: "last" as const },
      }),
    );
    await withCronStore(
      146,
      async ({ context, storePath }) => {
        const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
        cfg.session = { store: sessionStorePath };
        replaceSessionEntrySync(
          { agentId: "main", storePath: sessionStorePath, sessionKey: "agent:main:main" },
          {
            sessionId: "main",
            updatedAt: 1,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "main-recipient", accountId: "work" },
            }),
          },
        );
        const respond = await callCron(context, "cron.list", { includeDisabled: true, limit: 200 });
        expectReply(respond, expect.objectContaining({ jobs: expect.any(Array), total: 146 }));
        const page = respond.mock.calls[0]?.[1] as { jobs: CronJob[] };
        expect(page.jobs).toHaveLength(146);
        expect(page.jobs.map((job) => job.id).toSorted()).toEqual(
          jobs.map((job) => job.id).toSorted(),
        );
      },
      { config: cfg, jobs },
    );
  });

  it("keeps unsupported enabled delivery repairable beside healthy work and quarantine", () =>
    withCronStore(
      3,
      async ({ context, storePath, cron }) => {
        const db = openOpenClawStateDatabase().db;
        db.prepare(
          "UPDATE cron_jobs SET enabled = ?, payload_kind = 'systemEvent', job_json = json_set(job_json, '$.enabled', json(?), '$.delivery.mode', 'not-a-route', '$.sessionTarget', 'main', '$.payload', json(?)) WHERE store_key = ? AND job_id = 'job-0000'",
        ).run(
          1,
          "true",
          JSON.stringify({ kind: "systemEvent", text: "synthetic legacy job" }),
          cronStoreKey(storePath),
        );
        db.prepare(
          "UPDATE cron_jobs SET sort_order = 10, grant_definition_generation = 17, job_json = json_set(job_json, '$.notify', json('true'), '$.authoredNote', 'retain me') WHERE store_key = ? AND job_id = 'job-0000'",
        ).run(cronStoreKey(storePath));
        db.prepare(
          "UPDATE cron_jobs SET sort_order = 20 WHERE store_key = ? AND job_id = 'job-0001'",
        ).run(cronStoreKey(storePath));
        db.prepare(
          "UPDATE cron_jobs SET sort_order = 0, job_json = json_set(job_json, '$.schedule.everyMs', 0) WHERE store_key = ? AND job_id = 'job-0002'",
        ).run(cronStoreKey(storePath));
        const retained = () =>
          db
            .prepare(
              "SELECT agent_id, updated_at, grant_definition_revision, grant_definition_generation, grant_definition_updated_at FROM cron_jobs WHERE store_key = ? AND job_id = 'job-0000'",
            )
            .get(cronStoreKey(storePath));
        const retainedBefore = retained();
        const raw = () =>
          db
            .prepare("SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = 'job-0000'")
            .get(cronStoreKey(storePath))?.job_json;
        const original = raw();
        await cron.start();
        const quarantinedJobs = await loadCronQuarantinedJobs(storePath);
        expect(quarantinedJobs).toHaveLength(1);
        expect(quarantinedJobs[0]).toMatchObject({
          reason: "invalid-schedule",
          job: { id: "job-0002" },
        });
        expect(retained()).toEqual(retainedBefore);
        const listResponse = await callCron(context, "cron.list", {
          includeDisabled: true,
          limit: 10,
        });
        expectReply(
          listResponse,
          expect.objectContaining({
            total: 2,
            jobs: expect.arrayContaining([
              expect.objectContaining({
                id: "job-0000",
                delivery: { mode: "not-a-route" },
                configRevision: expect.any(String),
              }),
              expect.objectContaining({ id: "job-0001" }),
            ]),
            deliveryPreviews: expect.any(Object),
          }),
        );
        expect(JSON.stringify(listResponse.mock.calls[0]![1])).toContain(
          "delivery requires review",
        );
        await expect(cron.run("job-0001", "force")).resolves.toEqual({ ok: true, ran: true });
        await cron.update("job-0001", { name: "healthy sibling still editable" });
        expect(raw()).toBe(original);
        expect(retained()).toEqual(retainedBefore);
        expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
          "job-0000",
          "job-0001",
        ]);
        const runResponse = await callCron(context, "cron.run", { id: "job-0000", mode: "force" });
        expectError(
          runResponse,
          expect.objectContaining({ message: expect.stringContaining("openclaw doctor --fix") }),
        );
        for (const patch of [{ name: "unrelated edit" }, { state: { lastDurationMs: 99 } }]) {
          const response = await callCron(context, "cron.update", { id: "job-0000", patch });
          expectError(
            response,
            expect.objectContaining({
              message: expect.stringContaining("delivery requires an explicit mode"),
            }),
          );
          expect(raw()).toBe(original);
        }
        const corrected = await callCron(context, "cron.update", {
          id: "job-0000",
          patch: { delivery: { mode: "none" } },
        });
        expectReply(corrected, expect.objectContaining({ id: "job-0000" }));
        expect(JSON.parse(String(raw()))).not.toHaveProperty("delivery");
        expect((await cron.readJob("job-0001"))?.name).toBe("healthy sibling still editable");
      },
      { defaultAgentId: "ops" },
    ));

  it("keeps migrated owners outside a different ambient agent's reads and mutations", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { systemAgent: { agentId: "research" } },
      },
    };
    await withCronStore(
      0,
      async ({ context, storePath }) => {
        const historical = { ...createJobs(1)[0]!, id: "historical", agentId: "ops" };
        const explicit = { ...createJobs(1)[0]!, id: "explicit", agentId: "research" };
        await saveCronStore(storePath, { version: 1, jobs: [historical, explicit] });
        const before = await loadCronStore(storePath);
        const client = createCronCallerClient("research");
        const page = await listScoped(context, 0, undefined, client);
        expect(page, "An ambient agent must not see historical cron jobs").toMatchObject({
          total: 1,
          jobs: [{ id: explicit.id }],
        });
        expect((await listScoped(context, 0, undefined, null)).total).toBe(2);
        expect((await listScoped(context, 0, "agent:research:cron:historical", null)).total).toBe(
          0,
        );
        for (const method of ["cron.get", "cron.runs", "cron.update", "cron.remove"] as const) {
          const respond = await callCron(
            context,
            method,
            {
              id: historical.id,
              ...(method === "cron.update" ? { patch: { name: "changed" } } : {}),
            },
            { client },
          );
          expectError(
            respond,
            expect.objectContaining({
              details: expect.objectContaining({ code: "CRON_JOB_NOT_FOUND" }),
            }),
          );
          expect(await loadCronStore(storePath)).toEqual(before);
        }
      },
      { config, defaultAgentId: "research" },
    );
  });
  it("prepares one revision for concurrent lists while status does no listing work", () =>
    withCronStore(300, async ({ context, cron }) => {
      await cron.start();
      const revision = vi.spyOn(listRevision, "resolveCronListSnapshotRevision");
      const pages = await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          if (index % 2 === 0) {
            return listScoped(context, index, undefined, null);
          }
          const respond = await callCron(context, "cron.status", {});
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ jobs: 300 }),
            undefined,
          );
          return undefined;
        }),
      );
      expect(new Set(pages.flatMap((page) => (page ? [page.snapshotRevision] : []))).size).toBe(1);
      expect(revision).toHaveBeenCalledOnce();
      expect((await listScoped(context)).total).toBe(2);
      expect((await listScoped(context, 0, undefined, null)).total).toBe(300);
    }));
  it("filters session bindings before pagination without widening caller visibility", () =>
    withCronStore(401, async ({ context, storePath, cron }) => {
      await cron.start();
      const store = await loadCronStore(storePath);
      const sessionKey = "agent:ops:night-watch";
      for (const index of [0, 1, 200]) {
        store.jobs[index]!.sessionKey = sessionKey;
      }
      await saveCronStore(storePath, store);
      const sort = vi.spyOn(cronSort, "sortCronJobs");
      const page = await listScoped(context, 0, sessionKey);
      const visible = store.jobs.filter(
        (job) => job.agentId === "ops" && job.sessionKey === sessionKey,
      );
      expect(page).toMatchObject({
        offset: 0,
        limit: 1,
        hasMore: true,
        nextOffset: 1,
        snapshotRevision: listRevision.resolveCronListSnapshotRevision(visible),
      });
      expect(await loadCronStore(storePath)).toEqual(store);
      expect(sort.mock.calls.reduce((total, [jobs]) => total + jobs.length, 0)).toBeLessThanOrEqual(
        401,
      );
      expect(page).toMatchObject({ total: 2, jobs: [{ id: "job-0000" }] });
      expect((await listScoped(context, 1, sessionKey)).jobs.map((job) => job.id)).toEqual([
        "job-0200",
      ]);
      expect((await listScoped(context, 0, "agent:ops:missing")).total).toBe(0);
      // A user with inventory access also sees jobs run by another agent but bound here.
      expect((await listScoped(context, 0, sessionKey, null)).total).toBe(3);
      expect((await listScoped(context, 1, sessionKey, null)).jobs.map((job) => job.id)).toEqual([
        "job-0001",
      ]);
    }));

  it("keeps global-session filtering on the explicit job agent instead of the ambient default", () =>
    withCronStore(
      2,
      async ({ context, storePath }) => {
        const store = await loadCronStore(storePath);
        for (const job of store.jobs) {
          job.sessionKey = "main";
        }
        await saveCronStore(storePath, store);

        for (const client of [createCronCallerClient("ops"), null]) {
          const page = await listScoped(context, 0, "global", client);
          expect(page).toMatchObject({ total: 1, jobs: [{ id: "job-0000" }] });
        }
      },
      {
        config: {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: {}, ops: {}, other: {} },
          },
          session: { scope: "global" },
        },
      },
    ));

  it("isolates hidden changes while revising visible off-page changes and detaching rows", () =>
    withCronStore(401, async ({ context, storePath, cron }) => {
      await cron.start();
      const first = await listScoped(context);
      const store = await loadCronStore(storePath);
      store.jobs[1]!.name = "hidden replacement";
      await saveCronStore(storePath, store);
      expect((await listScoped(context)).snapshotRevision).toBe(first.snapshotRevision);

      store.jobs[400]!.name = "visible replacement";
      await saveCronStore(storePath, store);
      const changed = await listScoped(context);
      expect(changed.snapshotRevision).not.toBe(first.snapshotRevision);
      expect(changed.jobs).toEqual(first.jobs);
      expect((await listScoped(context, 2)).jobs).toEqual([
        expect.objectContaining({ id: "job-0400", name: "visible replacement" }),
      ]);
    }));
});
