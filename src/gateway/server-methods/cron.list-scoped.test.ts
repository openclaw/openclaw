import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { resolveCronListSnapshotRevision } from "../../cron/list-snapshot-revision.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import * as cronSort from "../../cron/service/list-page-sort.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
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

function scopedClient(): GatewayClient {
  const operationalRunInstance = createOperationalRunInstanceRef("cron-list-scope");
  return {
    connect: {} as GatewayClient["connect"],
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "ops",
        sessionKey: "agent:ops:main",
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
  run: (fixture: { context: GatewayRequestContext; storePath: string }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cron-list-scoped-"));
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const storePath = path.join(root, "jobs.json");
      await saveCronStore(storePath, { version: 1, jobs: createJobs(count) });
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      try {
        // Listing loads the real store without starting the scheduler.
        await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, async () => {
          const context: GatewayRequestContext = {
            ...expectDefined(
              getPluginRuntimeGatewayRequestScope()?.context,
              "local Gateway context",
            ),
            cron,
            cronStorePath: storePath,
          };
          await run({ context, storePath });
        });
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
  it("filters session bindings before pagination without widening caller visibility", async () => {
    await withCronStore(401, async ({ context, storePath }) => {
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
          snapshotRevision: resolveCronListSnapshotRevision(visible),
          jobs: [expect.objectContaining({ id: "job-0000" })],
        });
        expect(await loadCronStore(storePath)).toEqual(before);
        expect(sortedRows).toBeLessThanOrEqual(count);
      });
    },
  );

  it("isolates hidden changes while revising visible off-page changes and detaching rows", async () => {
    await withCronStore(401, async ({ context, storePath }) => {
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
