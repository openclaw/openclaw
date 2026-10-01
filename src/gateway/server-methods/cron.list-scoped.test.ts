import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as listRevision from "../../cron/list-snapshot-revision.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import * as cronSort from "../../cron/service/list-page-sort.js";
import { loadCronQuarantinedJobs, loadCronStore, saveCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withLocalGatewayRequestScope } from "../local-request-context.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(() => vi.restoreAllMocks());

function createJobs(count: number): CronJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `job-${String(index).padStart(4, "0")}`,
    name: `Job ${String(index).padStart(4, "0")}`,
    agentId: index % 200 === 0 ? "ops" : "other",
    enabled: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "scheduled check" },
    delivery: { mode: "none" },
    state: {},
  }));
}

function scopedClient(agentId = "ops"): GatewayClient {
  const operationalRunInstance = createOperationalRunInstanceRef("cron-list-scope");
  return {
    connect: {} as GatewayClient["connect"],
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId,
        sessionKey: `agent:${agentId}:main`,
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "test-generation",
          claimId: "test-claim",
        },
      },
    },
  };
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
    legacyDefaultAgentId?: string;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cron-list-scoped-"));
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const storePath = path.join(root, "jobs.json");
      await saveCronStore(storePath, { version: 1, jobs: createJobs(count) });
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: true,
        defaultAgentId: options.defaultAgentId ?? "main",
        legacyDefaultAgentId: options.legacyDefaultAgentId,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      try {
        // Listing loads the real store without starting the scheduler.
        await withLocalGatewayRequestScope(
          { deps: {}, getRuntimeConfig: () => options.config ?? {} },
          async () => {
            const context: GatewayRequestContext = {
              ...expectDefined(
                getPluginRuntimeGatewayRequestScope()?.context,
                "local Gateway context",
              ),
              cron,
              cronStorePath: storePath,
            };
            await run({ context, storePath, cron });
          },
        );
      } finally {
        cron.stop();
      }
    });
  } finally {
    // Retire worker admissions before removing storage, including failed fixture setup.
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: path.join(root, "state") }),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function listScoped(
  context: GatewayRequestContext,
  offset = 0,
  sessionKey?: string,
  client: GatewayClient | null = scopedClient(),
) {
  const respond = vi.fn();
  await expectDefined(
    cronHandlers["cron.list"],
    "cron.list handler",
  )({
    req: { type: "req", id: "cron-list-scoped", method: "cron.list" },
    params: {
      includeDisabled: true,
      includeDeliveryPreviews: false,
      ...(sessionKey ? { sessionKey, sessionAgentId: "ops" } : {}),
      sortBy: "name",
      limit: 1,
      offset,
    },
    context,
    client,
    respond,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.any(Object), undefined);
  return respond.mock.calls[0]![1] as {
    jobs: CronJob[];
    snapshotRevision: string;
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

describe("cron.list scoped SQLite snapshots", () => {
  it.each([
    { enabled: true, quarantine: false },
    { enabled: true, quarantine: true },
    { enabled: false, quarantine: true },
  ])(
    "keeps unsupported enabled=$enabled delivery repairable beside healthy work and quarantine=$quarantine",
    async ({ enabled, quarantine }) => {
      await withCronStore(
        quarantine ? 3 : 2,
        async ({ context, storePath, cron }) => {
          const db = openOpenClawStateDatabase().db;
          db.prepare(
            "UPDATE cron_jobs SET enabled = ?, payload_kind = 'systemEvent', job_json = json_set(job_json, '$.enabled', json(?), '$.delivery.mode', 'not-a-route', '$.sessionTarget', 'main', '$.payload', json(?)) WHERE store_key = ? AND job_id = 'job-0000'",
          ).run(
            enabled ? 1 : 0,
            JSON.stringify(enabled),
            JSON.stringify({ kind: "systemEvent", text: "synthetic legacy job" }),
            cronStoreKey(storePath),
          );
          db.prepare(
            "UPDATE cron_jobs SET sort_order = 10, grant_definition_generation = 17, job_json = json_set(job_json, '$.notify', json('true'), '$.authoredNote', 'retain me') WHERE store_key = ? AND job_id = 'job-0000'",
          ).run(cronStoreKey(storePath));
          db.prepare(
            "UPDATE cron_jobs SET sort_order = 20 WHERE store_key = ? AND job_id = 'job-0001'",
          ).run(cronStoreKey(storePath));
          if (quarantine) {
            db.prepare(
              "UPDATE cron_jobs SET sort_order = 0, job_json = json_set(job_json, '$.schedule.everyMs', 0) WHERE store_key = ? AND job_id = 'job-0002'",
            ).run(cronStoreKey(storePath));
          }
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
          expect(quarantinedJobs).toHaveLength(quarantine ? 1 : 0);
          if (quarantine) {
            expect(quarantinedJobs[0]).toMatchObject({
              reason: "invalid-schedule",
              job: { id: "job-0002" },
            });
          }
          expect(retained()).toEqual(retainedBefore);
          const listResponse = vi.fn();
          await expectDefined(
            cronHandlers["cron.list"],
            "cron.list",
          )({
            req: { type: "req", id: "legacy-delivery-list", method: "cron.list" },
            params: { includeDisabled: true, limit: 10 },
            context,
            client: null,
            respond: listResponse,
            isWebchatConnect: () => false,
          });
          expect(listResponse).toHaveBeenCalledExactlyOnceWith(
            true,
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
            undefined,
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
          const runResponse = vi.fn();
          await expectDefined(
            cronHandlers["cron.run"],
            "cron.run",
          )({
            req: { type: "req", id: "legacy-delivery-run", method: "cron.run" },
            params: { id: "job-0000", mode: "force" },
            context,
            client: null,
            respond: runResponse,
            isWebchatConnect: () => false,
          });
          expect(runResponse).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({ message: expect.stringContaining("openclaw doctor --fix") }),
          );
          for (const patch of [{ name: "unrelated edit" }, { state: { lastDurationMs: 99 } }]) {
            const response = vi.fn();
            await expectDefined(
              cronHandlers["cron.update"],
              "cron.update",
            )({
              req: { type: "req", id: "legacy-delivery-unrelated", method: "cron.update" },
              params: { id: "job-0000", patch },
              context,
              client: null,
              respond: response,
              isWebchatConnect: () => false,
            });
            expect(response).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({
                message: expect.stringContaining("delivery requires an explicit mode"),
              }),
            );
            expect(raw()).toBe(original);
          }
          const corrected = vi.fn();
          await expectDefined(
            cronHandlers["cron.update"],
            "cron.update",
          )({
            req: { type: "req", id: "legacy-delivery-correct", method: "cron.update" },
            params: { id: "job-0000", patch: { delivery: { mode: "none" } } },
            context,
            client: null,
            respond: corrected,
            isWebchatConnect: () => false,
          });
          expect(corrected).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining({ id: "job-0000" }),
            undefined,
          );
          expect(JSON.parse(String(raw()))).not.toHaveProperty("delivery");
          expect((await cron.readJob("job-0001"))?.name).toBe("healthy sibling still editable");
        },
        { defaultAgentId: "ops" },
      );
    },
  );

  it("keeps unrepaired historical jobs outside the ambient agent's reads and mutations", async () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
          defaults: { systemAgent: { agentId: "research" } },
        },
      },
      "ops",
    );
    await withCronStore(
      0,
      async ({ context, storePath }) => {
        const historical = { ...createJobs(1)[0]!, id: "historical", agentId: undefined };
        const explicit = { ...createJobs(1)[0]!, id: "explicit", agentId: "research" };
        await saveCronStore(storePath, { version: 1, jobs: [historical, explicit] });
        const before = await loadCronStore(storePath);
        const client = scopedClient("research");
        const page = await listScoped(context, 0, undefined, client);
        expect(page.total, "An ambient agent must not see historical cron jobs").toBe(1);
        expect(
          page.jobs.map((job) => job.id),
          "An ambient agent must not see historical cron jobs",
        ).toEqual([explicit.id]);
        expect((await listScoped(context, 0, undefined, null)).total).toBe(2);
        expect((await listScoped(context, 0, "agent:research:cron:historical", null)).total).toBe(
          0,
        );
        for (const method of ["cron.get", "cron.runs", "cron.update", "cron.remove"] as const) {
          const respond = vi.fn();
          await expectDefined(
            cronHandlers[method],
            method,
          )({
            req: { type: "req", id: method, method },
            params: {
              id: historical.id,
              ...(method === "cron.update" ? { patch: { name: "changed" } } : {}),
            },
            context,
            client,
            respond,
            isWebchatConnect: () => false,
          });
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: expect.objectContaining({ code: "CRON_JOB_NOT_FOUND" }),
            }),
          );
          expect(await loadCronStore(storePath)).toEqual(before);
        }
      },
      { config, defaultAgentId: "research", legacyDefaultAgentId: "ops" },
    );
  });
  it("prepares one revision for concurrent lists while status does no listing work", async () => {
    await withCronStore(300, async ({ context, cron }) => {
      await cron.start();
      const revision = vi.spyOn(listRevision, "resolveCronListSnapshotRevision");
      const pages = await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          if (index % 2 === 0) {
            return listScoped(context, index, undefined, null);
          }
          const respond = vi.fn();
          await expectDefined(
            cronHandlers["cron.status"],
            "cron.status",
          )({
            req: { type: "req", id: `status-${index}`, method: "cron.status" },
            params: {},
            context,
            client: null,
            respond,
            isWebchatConnect: () => false,
          });
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
    });
  });
  it("filters session bindings before pagination without widening caller visibility", async () => {
    await withCronStore(401, async ({ context, storePath, cron }) => {
      await cron.start();
      const store = await loadCronStore(storePath);
      const sessionKey = "agent:ops:night-watch";
      for (const index of [0, 1, 200]) {
        store.jobs[index]!.sessionKey = sessionKey;
      }
      await saveCronStore(storePath, store);
      const page = await listScoped(context, 0, sessionKey);
      expect(page.total).toBe(2);
      expect(page.jobs.map((job) => job.id)).toEqual(["job-0000"]);
      expect((await listScoped(context, 1, sessionKey)).jobs.map((job) => job.id)).toEqual([
        "job-0200",
      ]);
      expect((await listScoped(context, 0, "agent:ops:missing")).total).toBe(0);
      // A user with inventory access also sees jobs run by another agent but bound here.
      expect((await listScoped(context, 0, sessionKey, null)).total).toBe(3);
      expect((await listScoped(context, 1, sessionKey, null)).jobs.map((job) => job.id)).toEqual([
        "job-0001",
      ]);
    });
  });

  it.each([200, 201, 401])(
    "bounds sorting work while finding visible jobs across a %i-job inventory",
    async (count) => {
      await withCronStore(count, async ({ context, storePath }) => {
        const before = await loadCronStore(storePath);
        const sort = vi.spyOn(cronSort, "sortCronJobs");
        const page = await listScoped(context);
        const sortedRows = sort.mock.calls.reduce((total, [jobs]) => total + jobs.length, 0);
        const visible = before.jobs.filter((job) => job.agentId === "ops");
        expect(page).toMatchObject({
          total: visible.length,
          offset: 0,
          limit: 1,
          hasMore: visible.length > 1,
          nextOffset: visible.length > 1 ? 1 : null,
          snapshotRevision: listRevision.resolveCronListSnapshotRevision(visible),
          jobs: [expect.objectContaining({ id: "job-0000" })],
        });
        expect(await loadCronStore(storePath)).toEqual(before);
        expect(sortedRows).toBeLessThanOrEqual(count);
      });
    },
  );

  it("isolates hidden changes while revising visible off-page changes and detaching rows", async () => {
    await withCronStore(401, async ({ context, storePath, cron }) => {
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

      store.jobs[0]!.payload = { kind: "agentTurn", message: "replacement message" };
      await saveCronStore(storePath, store);
      await listScoped(context);
      expect(first.jobs[0]!.payload).toEqual({ kind: "agentTurn", message: "scheduled check" });
    });
  });
});
