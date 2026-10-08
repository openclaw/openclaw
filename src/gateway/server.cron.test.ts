// Gateway cron integration tests cover RPC projection, authority, runs, and webhook delivery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readCronRunRecordsForTests } from "../cron/run-history.test-support.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { getGatewayProcessInstanceId } from "./process-instance.js";
import type { GatewayCronState } from "./server-cron.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  connectOk,
  cronIsolatedRun,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: GuardedFetchOptions) => ({
    response: new Response("ok", { status: 200 }),
    finalUrl: params.url,
    release: async () => {},
  })),
);

const sendCronAnnouncePayloadStrictMock = vi.hoisted(() =>
  vi.fn<typeof import("../cron/delivery.js").sendCronAnnouncePayloadStrict>(async () => ({
    status: "sent",
    results: [{ channel: "telegram", messageId: "cron-message" }],
    receipt: {
      primaryPlatformMessageId: "cron-message",
      platformMessageIds: ["cron-message"],
      parts: [{ platformMessageId: "cron-message", kind: "text", index: 0 }],
      sentAt: 0,
    },
  })),
);

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../cron/delivery.js")>("../cron/delivery.js");
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: sendCronAnnouncePayloadStrictMock,
  };
});

installGatewayTestHooks({ scope: "suite" });
const CRON_WAIT_TIMEOUT_MS = 10_000;
let cronSuiteTempRootPromise: Promise<string> | null = null;
let cronSuiteCaseId = 0;

async function getCronSuiteTempRoot(): Promise<string> {
  if (!cronSuiteTempRootPromise) {
    cronSuiteTempRootPromise = fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-suite-"));
  }
  return await cronSuiteTempRootPromise;
}

async function rmTempDir(dir: string) {
  for (let i = 0; i < 100; i += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        await setImmediatePromise();
        continue;
      }
      throw err;
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function waitForCronEvent(
  ws: WebSocket,
  check: (payload: Record<string, unknown> | null) => boolean,
  timeoutMs = CRON_WAIT_TIMEOUT_MS,
) {
  const message = await onceMessage(
    ws,
    (obj) => {
      const payload = obj.payload ?? null;
      return obj.type === "event" && obj.event === "cron" && check(payload);
    },
    timeoutMs,
  );
  return message.payload ?? null;
}

async function cleanupCronTestRun(params: {
  ws?: { close: () => void };
  server?: { close: () => Promise<void> };
  cronState?: DirectCronState;
  prevSkipCron: string | undefined;
}) {
  params.ws?.close();
  await params.server?.close();
  params.cronState?.cron.stop();
  testState.cronStorePath = undefined;
  testState.cronEnabled = undefined;
  testState.cronTriggersEnabled = undefined;
  if (params.prevSkipCron === undefined) {
    delete process.env.OPENCLAW_SKIP_CRON;
    return;
  }
  process.env.OPENCLAW_SKIP_CRON = params.prevSkipCron;
}

let activeCronRun: Parameters<typeof cleanupCronTestRun>[0] | undefined;

async function startCronClient() {
  const { server, ws } = await startServerWithClient();
  Object.assign(expectDefined(activeCronRun, "cron setup"), { server, ws });
  await connectOk(ws);
  return ws;
}

async function setupCronTestRun(
  params: {
    cronEnabled?: boolean;
    cronTriggersEnabled?: boolean;
    sessionConfig?: { mainKey: string };
  } = {},
): Promise<{ dir: string }> {
  const prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
  activeCronRun = { prevSkipCron };
  process.env.OPENCLAW_SKIP_CRON = "0";
  const dir = path.join(await getCronSuiteTempRoot(), `case-${cronSuiteCaseId++}`);
  const storePath = path.join(dir, "cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  testState.cronStorePath = storePath;
  testState.sessionConfig = params.sessionConfig;
  testState.cronEnabled = params.cronEnabled ?? false;
  testState.cronTriggersEnabled = params.cronTriggersEnabled;
  await saveCronStore(storePath, { version: 1, jobs: [] });
  return { dir };
}

type DirectCronState = GatewayCronState & {
  getRuntimeConfig: () => import("../config/types.openclaw.js").OpenClawConfig;
};

type CronBroadcast = (event: string, payload: unknown) => void;

type DirectCronResponse = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
};

async function createDirectCronState(params?: {
  broadcast?: CronBroadcast;
}): Promise<DirectCronState> {
  resetConfigRuntimeState();
  const [{ getRuntimeConfig }, { buildGatewayCronService }] = await Promise.all([
    import("../config/config.js"),
    import("./server-cron.js"),
  ]);
  const cronState = {
    ...buildGatewayCronService({
      scheduler: createTestGatewayScheduler({
        ...createGatewaySchedulerClock().clock,
        now: () => Date.now(),
      }),
      cfg: getRuntimeConfig(),
      deps: {} as never,
      broadcast: params?.broadcast ?? vi.fn(),
    }),
    getRuntimeConfig,
  };
  expectDefined(activeCronRun, "cron setup").cronState = cronState;
  return cronState;
}

function createCronEventCollector() {
  const events: Record<string, unknown>[] = [];
  const waiters: Array<{
    check: (payload: Record<string, unknown>) => boolean;
    resolve: (payload: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const flush = (payload: Record<string, unknown>) => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter) {
        continue;
      }
      if (!waiter.check(payload)) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      waiter.resolve(payload);
    }
  };
  return {
    broadcast: (event: string, payload: unknown) => {
      if (event !== "cron" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return;
      }
      const record = payload as Record<string, unknown>;
      events.push(record);
      flush(record);
    },
    wait(check: (payload: Record<string, unknown>) => boolean, timeoutMs = CRON_WAIT_TIMEOUT_MS) {
      const existing = events.find(check);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const waiter = {
          check,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error("timeout waiting for cron event"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function directCronReq(
  cronState: DirectCronState,
  method: string,
  params: Record<string, unknown>,
  options: { client?: GatewayClient } = {},
): Promise<DirectCronResponse> {
  const { cronHandlers } = await import("./server-methods/cron.js");
  let result: DirectCronResponse | undefined;
  const respond = (ok: boolean, payload?: unknown, error?: DirectCronResponse["error"]) => {
    result = { ok, payload, error };
  };
  try {
    await expectDefined(
      cronHandlers[method],
      "cronHandlers[method] test invariant",
    )({
      req: {} as never,
      params,
      respond,
      context: {
        cron: cronState.cron,
        cronStorePath: cronState.storePath,
        logGateway: createInfoWarnErrorLogger(),
        getRuntimeConfig: cronState.getRuntimeConfig,
      } as never,
      client: options.client ?? null,
      isWebchatConnect: () => false,
    });
  } catch (err) {
    respond(false, undefined, {
      code: "unavailable",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return expectDefined(result, `${method} did not respond`);
}

function agentCronClient(
  sessionKey: string,
  options: { spawnContext?: boolean } = {},
): GatewayClient {
  const operationalRunInstance = createOperationalRunInstanceRef("run-cron-agent-creator");
  return {
    connect: {} as GatewayClient["connect"],
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "cron-agent-creator-generation",
          claimId: "cron-agent-creator-claim",
        },
        turnSourceAccountId: "default",
        ...(options.spawnContext
          ? {
              sessionSpawnContext: {
                inheritedToolPolicy: { version: 1, allow: ["*"], deny: [] },
              },
            }
          : {}),
      },
    },
  };
}

function expectCronJobIdFromResponse(response: { ok?: unknown; payload?: unknown }) {
  expect(response.ok, JSON.stringify((response as { error?: unknown }).error ?? null)).toBe(true);
  const value = (response.payload as { id?: unknown } | null)?.id;
  const id = typeof value === "string" ? value : "";
  expect(id.length > 0).toBe(true);
  return id;
}

async function addWebhookCronJob(params: {
  ws: WebSocket;
  name: string;
  sessionTarget?: "main" | "isolated";
  payloadText?: string;
  delivery: Record<string, unknown>;
  failureAlert?: Record<string, unknown>;
}) {
  const response = await rpcReq(params.ws, "cron.add", {
    name: params.name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: params.sessionTarget ?? "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: params.sessionTarget === "isolated" ? "agentTurn" : "systemEvent",
      ...(params.sessionTarget === "isolated"
        ? { message: params.payloadText ?? "test" }
        : { text: params.payloadText ?? "send webhook" }),
    },
    delivery: params.delivery,
    ...(params.failureAlert ? { failureAlert: params.failureAlert } : {}),
  });
  return expectCronJobIdFromResponse(response);
}

async function writeCronConfig(config: unknown) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  expect(typeof configPath).toBe("string");
  await fs.mkdir(path.dirname(configPath as string), { recursive: true });
  await fs.writeFile(configPath as string, JSON.stringify(config, null, 2), "utf-8");
  resetConfigRuntimeState();
}

function expectEnqueuedRunPayload(payload: unknown): string {
  const record = payload as { ok?: unknown; enqueued?: unknown; runId?: unknown } | null;
  expect(record?.ok).toBe(true);
  expect(record?.enqueued).toBe(true);
  expect(typeof record?.runId).toBe("string");
  return record?.runId as string;
}

async function runCronJobAndWaitForFinished(ws: WebSocket, jobId: string) {
  const finished = waitForCronEvent(
    ws,
    (payload) => payload?.jobId === jobId && payload?.action === "finished",
  );
  const response = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 20_000);
  expect(response.ok).toBe(true);
  expectEnqueuedRunPayload(response.payload);
  return await finished;
}

function getWebhookCall(index: number) {
  const [request] = expectDefined(fetchWithSsrFGuardMock.mock.calls[index], "webhook call");
  const rawBody = request.init?.body;
  if (typeof rawBody !== "string") {
    throw new Error("expected a JSON webhook body");
  }
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  return {
    url: request.url,
    method: request.init?.method,
    headers: new Headers(request.init?.headers),
    body,
  };
}

describe("gateway server cron", () => {
  beforeAll(async () => {
    await Promise.all([
      import("../config/config.js"),
      import("./server-cron.js"),
      import("./server-methods/cron.js"),
    ]);
  });

  afterAll(async () => {
    if (!cronSuiteTempRootPromise) {
      return;
    }
    await rmTempDir(await cronSuiteTempRootPromise);
    cronSuiteTempRootPromise = null;
    cronSuiteCaseId = 0;
  });

  afterEach(async () => {
    const run = activeCronRun;
    activeCronRun = undefined;
    if (run) {
      await cleanupCronTestRun(run);
    }
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    resetConfigRuntimeState();
  });

  beforeEach(() => {
    // Keep polling helpers deterministic even if other tests left fake timers enabled.
    vi.useRealTimers();
    sendCronAnnouncePayloadStrictMock.mockClear();
  });

  test("defaults cron.add agentTurn targets from available session context", async () => {
    await setupCronTestRun();
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:webchat:loop" },
      { sessionId: "loop", updatedAt: 1 },
    );
    const cronState = await createDirectCronState();

    const withContext = await directCronReq(cronState, "cron.add", {
      name: "conversation loop",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionKey: "agent:main:webchat:loop",
      payload: { kind: "agentTurn", message: "check status" },
    });
    expect(withContext.ok).toBe(true);
    expect(withContext.payload).toMatchObject({
      sessionTarget: "current",
      sessionKey: "agent:main:webchat:loop",
      delivery: { mode: "announce" },
    });

    const withoutContext = await directCronReq(cronState, "cron.add", {
      name: "detached loop",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "check status" },
    });
    expect(withoutContext.ok).toBe(true);
    expect(withoutContext.payload).toMatchObject({
      sessionTarget: "isolated",
      delivery: { mode: "announce" },
      deliveryPreview: {
        label: "announce -> last",
        detail: expect.stringContaining("last -> no route, will fail-closed"),
      },
    });
  });

  test("does not persist cron.add when the delivery preview cannot be resolved", async () => {
    const { dir } = await setupCronTestRun();
    testState.sessionStorePath = path.join(dir, "invalid.sqlite");
    await fs.writeFile(testState.sessionStorePath, "not a SQLite database");
    const cronState = await createDirectCronState();

    const response = await directCronReq(cronState, "cron.add", {
      name: "preview failure",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "check status" },
    });

    expect(response.ok).toBe(false);
    expect(await cronState.cron.list({ includeDisabled: true })).toHaveLength(0);
  });

  test("persists an agent-created job with its caller session creator", async () => {
    const { dir } = await setupCronTestRun();
    const attributedSessionKey = "agent:main:dashboard:attributed";
    const unattributedSessionKey = "agent:main:dashboard:unattributed";
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      agentId: "main",
      entries: {
        [attributedSessionKey]: {
          sessionId: "session-attributed",
          updatedAt: 2,
          createdAt: 1,
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "profile-ada", label: "Ada" },
        },
        [unattributedSessionKey]: {
          sessionId: "session-unattributed",
          updatedAt: 2,
          createdAt: 1,
          createdVia: "run",
        },
      },
    });
    const cronState = await createDirectCronState();
    const addJob = async (name: string, sessionKey: string) =>
      await directCronReq(
        cronState,
        "cron.add",
        {
          name,
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "test", toolsAllow: ["*"] },
          delivery: { mode: "none" },
        },
        {
          client: agentCronClient(sessionKey, {
            spawnContext: sessionKey === attributedSessionKey,
          }),
        },
      );

    const attributed = await addJob("attributed", attributedSessionKey);
    const unattributed = await addJob("unattributed", unattributedSessionKey);

    expect(attributed.ok, JSON.stringify(attributed.error ?? null)).toBe(true);
    expect(attributed.payload).not.toHaveProperty("createdActor");
    expect(unattributed.ok, JSON.stringify(unattributed.error ?? null)).toBe(true);
    const jobs = (await loadCronStore(cronState.storePath)).jobs;
    expect(jobs.find((job) => job.name === "attributed")).toMatchObject({
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
    });
    expect(jobs.find((job) => job.name === "unattributed")).not.toHaveProperty("createdActor");
  });

  test(
    "projects public cron jobs through CRUD responses and events",
    { timeout: 45_000 },
    async () => {
      await setupCronTestRun({ sessionConfig: { mainKey: "primary" } });
      const events = createCronEventCollector();
      const cronState = await createDirectCronState({ broadcast: events.broadcast });
      const preview = { label: "webhook:https://example.invalid/cron-finished", detail: "webhook" };
      const added = await directCronReq(cronState, "cron.add", {
        name: "daily",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });
      const id = expectCronJobIdFromResponse(added);
      expect(added.payload).toMatchObject({ deliveryPreview: preview });
      const internal = expectDefined(cronState.cron.getJob(id), "created cron job");
      internal.state.queuedAtMs = Date.now();
      internal.state.startupCatchupAtMs = Date.now() + 5_000;

      const updated = await directCronReq(cronState, "cron.update", {
        id,
        patch: { description: "public projection check" },
      });
      expect(updated.ok).toBe(true);
      const event = await events.wait(
        (payload) => payload.jobId === id && payload.action === "updated",
      );
      const listed = await directCronReq(cronState, "cron.list", { includeDisabled: true });
      expect(listed.ok).toBe(true);
      const listing = listed.payload as {
        jobs: Array<Record<string, unknown>>;
        deliveryPreviews: Record<string, unknown>;
      };
      expect(listing.jobs).toMatchObject([{ name: "daily", delivery: { mode: "webhook" } }]);
      expect(listing.deliveryPreviews[id]).toEqual(preview);
      const fetched = await directCronReq(cronState, "cron.get", { id });
      expect(fetched.ok).toBe(true);
      expect(fetched.payload).toMatchObject({ id, name: "daily" });
      for (const job of [updated.payload, event.job, listing.jobs[0], fetched.payload]) {
        expect(job).toHaveProperty("state");
        expect(job).not.toHaveProperty("state.queuedAtMs");
        expect(job).not.toHaveProperty("state.startupCatchupAtMs");
      }

      const noPreview = await directCronReq(cronState, "cron.list", {
        includeDeliveryPreviews: false,
        includeDisabled: true,
      });
      expect(noPreview.ok).toBe(true);
      expect(noPreview.payload).not.toHaveProperty("deliveryPreviews");
      const compact = await directCronReq(cronState, "cron.list", {
        compact: true,
        includeDisabled: true,
      });
      expect(compact.ok).toBe(true);
      const compactJobs = (compact.payload as { jobs: Array<Record<string, unknown>> }).jobs;
      expect(compactJobs).toHaveLength(1);
      expect(compactJobs[0]).toStrictEqual({
        id,
        effectiveAgentId: "main",
        name: "daily",
        enabled: true,
        updatedAtMs: expect.any(Number),
        scheduleKind: "every",
        schedule: expect.objectContaining({ kind: "every", everyMs: 60_000 }),
        nextRunAt: expect.any(String),
        nextRunAtMs: expect.any(Number),
        lastRunAt: null,
        lastRunAtMs: null,
        lastRunError: null,
        lastRunStatus: null,
      });
      expect(Date.parse(String(compactJobs[0]?.nextRunAt))).toBe(compactJobs[0]?.nextRunAtMs);
      expect(compact.payload).not.toHaveProperty("deliveryPreviews");
      const missing = await directCronReq(cronState, "cron.get", { id: "missing-job-id" });
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("cron job not found: missing-job-id"),
      });
    },
  );

  test("atomically rejects stale config revisions without conflicting on runtime state", async () => {
    await setupCronTestRun();
    const cronState = await createDirectCronState();

    const added = await directCronReq(cronState, "cron.add", {
      name: "revision protected",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "original" },
    });
    expect(added.ok).toBe(true);
    const addedJob = added.payload as { id: string };
    const initial = await directCronReq(cronState, "cron.get", { id: addedJob.id });
    const initialJob = initial.payload as {
      id: string;
      configRevision: string;
      updatedAtMs: number;
    };

    const runtimeOnly = await directCronReq(cronState, "cron.update", {
      id: initialJob.id,
      patch: { state: { lastRunAtMs: 1_700_000_000_000 } },
    });
    expect(runtimeOnly.ok).toBe(true);
    expect(runtimeOnly.payload).toMatchObject({
      configRevision: initialJob.configRevision,
    });

    const first = await directCronReq(cronState, "cron.update", {
      id: initialJob.id,
      expectedConfigRevision: initialJob.configRevision,
      patch: { description: "first writer" },
    });
    expect(first.ok).toBe(true);
    const firstJob = first.payload as { configRevision: string; updatedAtMs: number };
    expect(firstJob.configRevision).not.toBe(initialJob.configRevision);
    expect(firstJob.updatedAtMs).toBeGreaterThan(initialJob.updatedAtMs);

    const stale = await directCronReq(cronState, "cron.update", {
      id: initialJob.id,
      expectedConfigRevision: initialJob.configRevision,
      patch: { description: "stale writer" },
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: {
        code: "CRON_JOB_CHANGED",
        expectedConfigRevision: initialJob.configRevision,
        actualConfigRevision: firstJob.configRevision,
      },
    });

    const current = await directCronReq(cronState, "cron.get", { id: initialJob.id });
    expect(current.payload).toMatchObject({
      description: "first writer",
      updatedAtMs: firstJob.updatedAtMs,
    });
  });

  test("atomically rejects chat delivery after gateway config changes the default agent", async () => {
    await setupCronTestRun();

    await writeCronConfig({
      session: { mainKey: "main" },
      agents: { entries: { ops: {} } },
      channels: { telegram: { botToken: "telegram-token" } },
    });

    const cronState = await createDirectCronState();

    const addRes = await directCronReq(cronState, "cron.add", {
      name: "main default agent drift",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      agentId: "ops",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });
    const jobId = expectCronJobIdFromResponse(addRes);

    await writeCronConfig({
      session: { mainKey: "main" },
      agents: { defaults: { systemAgent: { agentId: "main" } }, entries: { main: {}, ops: {} } },
      channels: { telegram: { botToken: "telegram-token" } },
    });

    const agentIds = Object.keys(cronState.getRuntimeConfig().agents?.entries ?? {});
    expect(agentIds).toContain("main");
    expect(agentIds).toContain("ops");
    expect(cronState.cron.getDefaultAgentId()).toBe("main");

    const before = await directCronReq(cronState, "cron.get", { id: jobId });
    const updateRes = await directCronReq(cronState, "cron.update", {
      id: jobId,
      patch: {
        name: "must not persist",
        delivery: { mode: "announce", channel: "telegram", to: "19098680" },
      },
    });

    expect(updateRes.ok).toBe(false);
    expect(updateRes.error?.message).toContain("cron channel delivery config");
    expect(await directCronReq(cronState, "cron.get", { id: jobId })).toEqual(before);

    const renamed = await directCronReq(cronState, "cron.update", {
      id: jobId,
      patch: { name: "renamed after default drift" },
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.payload).toMatchObject({
      name: "renamed after default drift",
      agentId: "ops",
    });

    const afterRename = await directCronReq(cronState, "cron.get", { id: jobId });
    for (const bindingPatch of [
      { agentId: "ops" },
      { sessionTarget: "main" },
      { payload: { kind: "systemEvent", text: "new work" } },
    ]) {
      const retargeted = await directCronReq(cronState, "cron.update", {
        id: jobId,
        patch: { name: "must not persist binding", ...bindingPatch },
      });
      expect(retargeted.ok).toBe(false);
      expect(retargeted.error?.message).toContain('sessionTarget "main" is only valid');
      expect(await directCronReq(cronState, "cron.get", { id: jobId })).toEqual(afterRename);
    }
  });

  test("writes cron run history and auto-runs due jobs", async () => {
    await setupCronTestRun({
      cronEnabled: true,
    });
    await writeCronConfig({
      agents: { defaults: { systemAgent: { agentId: "main" } }, entries: { main: {}, writer: {} } },
    });
    const events = createCronEventCollector();
    const cronState = await createDirectCronState({ broadcast: events["broadcast"] });

    const addRes = await directCronReq(cronState, "cron.add", {
      name: "log test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });
    const jobId = expectCronJobIdFromResponse(addRes);

    const finishedRun = events.wait(
      (payload) => payload?.jobId === jobId && payload?.action === "finished",
    );
    const runRes = await directCronReq(cronState, "cron.run", { id: jobId, mode: "force" });
    expect(runRes.ok).toBe(true);
    expectEnqueuedRunPayload(runRes.payload);
    const manualRunId = (runRes.payload as { runId?: unknown } | null)?.runId;
    expect(typeof manualRunId).toBe("string");
    const finishedPayload = await finishedRun;
    expect(finishedPayload).toMatchObject({
      jobId,
      action: "finished",
      status: "ok",
      summary: "hello",
      deliveryStatus: "not-requested",
    });

    const runsRes = await directCronReq(cronState, "cron.runs", { id: jobId, limit: 50 });
    expect(runsRes.ok).toBe(true);
    const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      jobId,
      jobName: "log test",
      summary: "hello",
      deliveryStatus: "not-requested",
      runId: manualRunId,
    });
    const allRunsRes = await directCronReq(cronState, "cron.runs", {
      scope: "all",
      limit: 50,
      statuses: ["ok"],
    });
    expect(allRunsRes.ok).toBe(true);
    const allEntries = (allRunsRes.payload as { entries?: unknown } | null)?.entries;
    expect(Array.isArray(allEntries)).toBe(true);
    expect((allEntries as Array<{ jobId?: unknown }>).some((entry) => entry.jobId === jobId)).toBe(
      true,
    );

    const writerAddResult = await cronState.cron.add({
      name: "writer log test",
      agentId: "writer",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "writer hello" },
    });
    const writerJobId = ("job" in writerAddResult ? writerAddResult.job : writerAddResult).id;
    const writerFinished = events.wait(
      (payload) => payload?.jobId === writerJobId && payload?.action === "finished",
    );
    const writerRun = await directCronReq(cronState, "cron.run", {
      id: writerJobId,
      mode: "force",
    });
    expect(writerRun.ok).toBe(true);
    await writerFinished;

    const mainRuns = await directCronReq(cronState, "cron.runs", {
      scope: "all",
      agentId: "main",
    });
    const writerRuns = await directCronReq(cronState, "cron.runs", {
      scope: "all",
      agentId: "writer",
    });
    expect((mainRuns.payload as { entries: Array<{ jobId: string }> }).entries).not.toContainEqual(
      expect.objectContaining({ jobId: writerJobId }),
    );
    expect((writerRuns.payload as { entries: Array<{ jobId: string }> }).entries).toContainEqual(
      expect.objectContaining({ jobId: writerJobId }),
    );

    const removeWriter = await directCronReq(cronState, "cron.remove", { id: writerJobId });
    expect(removeWriter.ok).toBe(true);
    expect(readCronRunRecordsForTests(writerJobId)).toEqual([
      expect.objectContaining({ jobId: writerJobId, agentId: "writer" }),
    ]);
    const retainedWriterRuns = await directCronReq(cronState, "cron.runs", {
      scope: "all",
      agentId: "writer",
    });
    expect(retainedWriterRuns.payload).toMatchObject({
      entries: [expect.objectContaining({ jobId: writerJobId })],
      total: 1,
    });

    const statusRes = await directCronReq(cronState, "cron.status", {});
    expect(statusRes.ok).toBe(true);
    expect(statusRes.payload).toMatchObject({
      enabled: true,
      storePath: expect.stringContaining("openclaw.sqlite"),
    });

    const autoRes = await directCronReq(cronState, "cron.add", {
      name: "auto run test",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() - 1).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "auto" },
    });
    const autoJobId = expectCronJobIdFromResponse(autoRes);

    const autoFinished = events.wait(
      (payload) => payload?.jobId === autoJobId && payload?.action === "finished",
    );
    await cronState.cron.start();
    await autoFinished;
    const autoEntries = (await directCronReq(cronState, "cron.runs", { id: autoJobId, limit: 10 }))
      .payload as { entries?: Array<{ jobId?: unknown }> } | undefined;
    expect(Array.isArray(autoEntries?.entries)).toBe(true);
    const runs = autoEntries?.entries ?? [];
    expect(runs.at(-1)?.jobId).toBe(autoJobId);
  }, 45_000);

  test("bundled plugin runtime runs enabled automations and skips disabled ones", async () => {
    await setupCronTestRun({
      cronEnabled: true,
    });
    const events = createCronEventCollector();
    const cronState = await createDirectCronState({ broadcast: events["broadcast"] });

    const addRes = await directCronReq(cronState, "cron.add", {
      name: "plugin runtime nudge",
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 1 1 *", tz: "America/Los_Angeles" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "plugin runtime nudge" },
    });
    const jobId = expectCronJobIdFromResponse(addRes);
    const finishedRun = events.wait(
      (payload) => payload.jobId === jobId && payload.action === "finished",
    );
    const runtime = createPluginRuntime();
    const context = {
      trackExecution: trackAsyncWork,
      cron: cronState.cron,
      cronStorePath: cronState.storePath,
      logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getRuntimeConfig: cronState.getRuntimeConfig,
    } as never;

    const runThroughPlugin = async (id: string) =>
      await withPluginRuntimeGatewayRequestScope(
        {
          context,
          client: {
            connect: { scopes: ["operator.read"] },
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "foreign-agent",
                sessionKey: "agent:foreign-agent:main",
                turnSourceAccountId: "default",
              },
            },
          } as never,
          isWebchatConnect: () => false,
          pluginId: "workboard",
          pluginOrigin: "bundled",
        },
        async () =>
          await runtime.gateway.request(
            "cron.run",
            { id, mode: "if-enabled" },
            { scopes: ["operator.admin"] },
          ),
      );

    const runRes = await runThroughPlugin(jobId);

    expect(runRes).toMatchObject({ ok: true, enqueued: true });
    await expect(finishedRun).resolves.toMatchObject({
      jobId,
      action: "finished",
      status: "ok",
    });
    const runsRes = await directCronReq(cronState, "cron.runs", { id: jobId, limit: 5 });
    expect(runsRes.ok).toBe(true);
    expect((runsRes.payload as { entries?: Array<{ jobId?: string }> }).entries).toEqual([
      expect.objectContaining({ jobId }),
    ]);

    const disabledAddRes = await directCronReq(cronState, "cron.add", {
      name: "disabled plugin runtime nudge",
      enabled: false,
      schedule: { kind: "cron", expr: "0 3 1 1 *", tz: "America/Los_Angeles" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "disabled plugin runtime nudge" },
    });
    const disabledJobId = expectCronJobIdFromResponse(disabledAddRes);
    await expect(runThroughPlugin(disabledJobId)).resolves.toMatchObject({
      ok: true,
      ran: false,
      reason: "disabled",
    });
    const disabledRuns = await directCronReq(cronState, "cron.runs", {
      id: disabledJobId,
      limit: 5,
    });
    expect(disabledRuns.ok).toBe(true);
    expect((disabledRuns.payload as { entries?: unknown[] }).entries).toEqual([]);
  });

  test("cron.run waitTimeoutMs returns the finished run, or only its runId when the wait ends first", async () => {
    const runnerEntered = createDeferred();
    const slowResult = createDeferred<{ status: "ok"; summary: string }>();
    cronIsolatedRun.mockImplementationOnce(() => {
      runnerEntered.resolve();
      return slowResult.promise;
    });
    await setupCronTestRun();
    const ws = await startCronClient();
    const jobId = await addWebhookCronJob({
      ws,
      name: "waited job",
      sessionTarget: "isolated",
      payloadText: "report",
      delivery: { mode: "none" },
    });

    const pending = await rpcReq(ws, "cron.run", { id: jobId, waitTimeoutMs: 50 }, 5_000);
    expect(pending.ok).toBe(true);
    expect(pending.payload).toEqual({
      ok: true,
      enqueued: true,
      runId: expect.any(String),
      processInstanceId: getGatewayProcessInstanceId(),
    });
    await runnerEntered.promise;
    const slowFinished = waitForCronEvent(
      ws,
      (payload) => payload?.jobId === jobId && payload?.action === "finished",
    );
    slowResult.resolve({ status: "ok", summary: "late report" });
    await slowFinished;

    cronIsolatedRun.mockResolvedValueOnce({ status: "ok", summary: "waited report" });
    const done = await rpcReq(ws, "cron.run", { id: jobId, waitTimeoutMs: 10_000 }, 15_000);
    expect(done.ok).toBe(true);
    const runId = expectEnqueuedRunPayload(done.payload);
    expect(done.payload).toMatchObject({
      run: { runId, status: "ok", completionStatus: "succeeded", summary: "waited report" },
    });
  });

  test("returns already-running without starting background work", async () => {
    const runnerEntered = createDeferred();
    const runResult = createDeferred<{ status: "ok"; summary: string }>();
    cronIsolatedRun.mockImplementationOnce(() => {
      runnerEntered.resolve();
      return runResult.promise;
    });

    await setupCronTestRun();

    const ws = await startCronClient();

    const jobId = await addWebhookCronJob({
      ws,
      name: "busy job",
      sessionTarget: "isolated",
      payloadText: "still busy",
      delivery: { mode: "none" },
    });
    const startedRun = waitForCronEvent(
      ws,
      (payload) => payload?.jobId === jobId && payload?.action === "started",
    );
    const firstRunRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 1_000);
    expect(firstRunRes.ok).toBe(true);
    expectEnqueuedRunPayload(firstRunRes.payload);
    await Promise.all([startedRun, runnerEntered.promise]);
    expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

    const secondRunRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 1_000);
    expect(secondRunRes.ok).toBe(true);
    expect(secondRunRes.payload).toEqual({
      ok: true,
      ran: false,
      reason: "already-running",
      processInstanceId: getGatewayProcessInstanceId(),
    });
    expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

    const finishedRun = waitForCronEvent(
      ws,
      (payload) => payload?.jobId === jobId && payload?.action === "finished",
    );
    runResult.resolve({ status: "ok", summary: "busy done" });
    await finishedRun;
  });

  test("posts authenticated primary and completion webhooks", async () => {
    await setupCronTestRun();

    await writeCronConfig({
      cron: {
        webhookToken: "cron-webhook-token",
        failureAlert: { after: 1 },
      },
    });

    fetchWithSsrFGuardMock.mockClear();

    const ws = await startCronClient();

    const notifyJobId = await addWebhookCronJob({
      ws,
      name: "webhook enabled",
      delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
    });
    const notifyFinished = await runCronJobAndWaitForFinished(ws, notifyJobId);
    const notifyCall = getWebhookCall(0);
    expect(notifyCall.url).toBe("https://example.invalid/cron-finished");
    expect(notifyCall.method).toBe("POST");
    expect(notifyCall.headers.get("Authorization")).toBe("Bearer cron-webhook-token");
    expect(notifyCall.headers.get("Content-Type")).toBe("application/json");
    const notifyBody = notifyCall.body;
    expect(notifyBody.action).toBe("finished");
    expect(notifyBody.jobId).toBe(notifyJobId);
    expect(notifyBody.summary).toBe("send webhook");
    expect(notifyFinished).toMatchObject({
      status: "ok",
      delivered: true,
      deliveryStatus: "delivered",
    });

    const notifyRuns = await rpcReq(ws, "cron.runs", { id: notifyJobId, limit: 10 });
    expect(notifyRuns.ok).toBe(true);
    const notifyEntries = (notifyRuns.payload as { entries?: unknown } | null)?.entries;
    expect(Array.isArray(notifyEntries)).toBe(true);
    expect((notifyEntries as Array<{ deliveryStatus?: unknown }>).at(-1)?.deliveryStatus).toBe(
      "delivered",
    );

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);

    const completionJobId = await addWebhookCronJob({
      ws,
      name: "announce plus completion webhook",
      sessionTarget: "isolated",
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "https://example.invalid/completion-destination",
        },
      },
    });
    await runCronJobAndWaitForFinished(ws, completionJobId);
    const completionCall = getWebhookCall(1);
    expect(completionCall.url).toBe("https://example.invalid/completion-destination");
    expect(completionCall.method).toBe("POST");
    expect(completionCall.headers.get("Authorization")).toBe("Bearer cron-webhook-token");
    expect(completionCall.body.action).toBe("finished");
    expect(completionCall.body.jobId).toBe(completionJobId);
    expect(completionCall.body.summary).toBe("ok");
  }, 60_000);

  test("omits raw summaries from failed cron webhook payloads", async () => {
    await setupCronTestRun();

    await writeCronConfig({
      cron: {
        webhookToken: "cron-webhook-token",
      },
    });

    fetchWithSsrFGuardMock.mockClear();
    const ws = await startCronClient();

    const rawSummary = [
      "stdout:",
      "To sign in, use a web browser to open https://microsoft.com/devicelogin",
      "and enter the code ABCD-1234 to authenticate.",
    ].join("\n");
    cronIsolatedRun.mockResolvedValueOnce({
      status: "error",
      error: "command exited with code 7",
      summary: rawSummary,
      diagnostics: {
        summary: rawSummary,
        entries: [
          {
            ts: 123,
            source: "exec",
            severity: "error",
            message: rawSummary,
          },
        ],
      },
    });
    const directJobId = await addWebhookCronJob({
      ws,
      name: "failed direct webhook",
      sessionTarget: "isolated",
      delivery: { mode: "webhook", to: "https://example.invalid/failed-direct" },
    });
    await runCronJobAndWaitForFinished(ws, directJobId);
    const directCall = getWebhookCall(0);
    expect(directCall.url).toBe("https://example.invalid/failed-direct");
    expect(directCall.headers.get("Authorization")).toBe("Bearer cron-webhook-token");
    expect(directCall.body).toMatchObject({
      action: "finished",
      jobId: directJobId,
      status: "error",
      error: "command exited with code 7",
    });
    expect(directCall.body).not.toHaveProperty("summary");
    expect(directCall.body).not.toHaveProperty("diagnostics");
    expect(JSON.stringify(directCall.body)).not.toContain("ABCD-1234");
  }, 45_000);

  test("persists settled failure-alert outcomes for cron get and list", async () => {
    await setupCronTestRun();
    const ws = await startCronClient();

    const expectOutcome = async (jobId: string, expected: Record<string, unknown>) => {
      await vi.waitFor(async () => {
        const getResult = await rpcReq(ws, "cron.get", { id: jobId });
        expect(getResult.payload).toMatchObject(expected);
        for (const compact of [false, true]) {
          const listResult = await rpcReq(ws, "cron.list", {
            compact,
            includeDeliveryPreviews: false,
          });
          const listed = (
            listResult.payload as { jobs?: Array<Record<string, unknown>> } | null
          )?.jobs?.find((job) => job.id === jobId);
          expect(listed).toMatchObject(expected);
        }
      });
    };

    cronIsolatedRun.mockResolvedValueOnce({ status: "error", error: "job failed" });
    const deliveredJobId = await addWebhookCronJob({
      ws,
      name: "delivered failure alert",
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      failureAlert: {
        after: 1,
        mode: "webhook",
        to: "https://example.invalid/delivered-failure-alert",
      },
    });
    await runCronJobAndWaitForFinished(ws, deliveredJobId);
    await expectOutcome(deliveredJobId, {
      lastFailureNotificationDelivered: true,
      lastFailureNotificationDeliveryStatus: "delivered",
    });

    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("alert transport rejected"));
    cronIsolatedRun.mockResolvedValueOnce({ status: "error", error: "job failed" });
    const failedJobId = await addWebhookCronJob({
      ws,
      name: "failed failure alert",
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      failureAlert: {
        after: 1,
        mode: "webhook",
        to: "https://example.invalid/failed-failure-alert",
      },
    });
    await runCronJobAndWaitForFinished(ws, failedJobId);
    await expectOutcome(failedJobId, {
      lastFailureNotificationDelivered: false,
      lastFailureNotificationDeliveryStatus: "not-delivered",
      lastFailureNotificationDeliveryError: expect.stringContaining("alert transport rejected"),
    });

    sendCronAnnouncePayloadStrictMock.mockImplementationOnce(async (params) => {
      params.onDeliveryAttempt?.(false);
      return {
        status: "suppressed",
        results: [],
        receipt: {
          primaryPlatformMessageId: undefined,
          platformMessageIds: [],
          parts: [],
          sentAt: 0,
        },
        reason: "adapter_returned_no_send",
      };
    });
    cronIsolatedRun.mockResolvedValueOnce({ status: "error", error: "job failed" });
    const unreachedJobId = await addWebhookCronJob({
      ws,
      name: "unreached failure alert",
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      failureAlert: { after: 1, mode: "announce", channel: "last" },
    });
    await runCronJobAndWaitForFinished(ws, unreachedJobId);
    await expectOutcome(unreachedJobId, {
      lastFailureNotificationDelivered: false,
      lastFailureNotificationDeliveryStatus: "not-delivered",
      lastFailureNotificationDeliveryError: expect.stringContaining("adapter_returned_no_send"),
    });
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  }, 45_000);
  test("returns INVALID_REQUEST when cron trigger authoring is disabled", async () => {
    await setupCronTestRun({
      cronTriggersEnabled: false,
    });
    const cronState = await createDirectCronState();

    await expect(directCronReq(cronState, "cron.status", {})).resolves.toMatchObject({
      ok: true,
      payload: { enabled: false, triggersEnabled: false },
    });
    const response = await directCronReq(cronState, "cron.add", {
      name: "disabled watcher",
      enabled: true,
      schedule: { kind: "every", everyMs: 30_000 },
      trigger: { script: "json({ fire: true })" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "changed" },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("INVALID_REQUEST");
    expect(response.error?.message).toContain("cron triggers are disabled");
  });

  test("rejects malformed cron payload and trigger scripts before persistence", async () => {
    await setupCronTestRun({
      cronEnabled: true,
    });
    const cronState = await createDirectCronState();

    const response = await directCronReq(cronState, "cron.add", {
      name: "malformed script",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "script", script: "const x = ;" },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("INVALID_REQUEST");
    expect(response.error?.message).toContain(
      "cron script payload has a syntax error: Unexpected token (line 1, column 10)",
    );

    const triggerInput = {
      name: "condition watcher",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "changed" },
    };
    const invalidTrigger = { script: "const x = ;" };
    const expectedTriggerError =
      "cron trigger script has a syntax error: Unexpected token (line 1, column 10)";
    const invalidCreate = await directCronReq(cronState, "cron.add", {
      ...triggerInput,
      trigger: invalidTrigger,
    });

    expect(invalidCreate.ok).toBe(false);
    expect(invalidCreate.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining(expectedTriggerError),
    });
    expect((await loadCronStore(cronState.storePath)).jobs).toEqual([]);

    const validTrigger = { script: "return { fire: true }" };
    const created = await directCronReq(cronState, "cron.add", {
      ...triggerInput,
      trigger: validTrigger,
    });
    const jobId = expectCronJobIdFromResponse(created);
    const invalidUpdate = await directCronReq(cronState, "cron.update", {
      id: jobId,
      patch: { trigger: invalidTrigger },
    });

    expect(invalidUpdate.ok).toBe(false);
    expect(invalidUpdate.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining(expectedTriggerError),
    });
    expect((await loadCronStore(cronState.storePath)).jobs).toEqual([
      expect.objectContaining({ id: jobId, trigger: validTrigger }),
    ]);
  });

  test("accepts opaque custom session ids on add and update", async () => {
    await setupCronTestRun();

    const cronState = await createDirectCronState();

    const addRes = await directCronReq(cronState, "cron.add", {
      name: "dingtalk group session",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(addRes.ok).toBe(true);
    expect(addRes.payload).toMatchObject({
      sessionTarget: "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
    });

    const validRes = await directCronReq(cronState, "cron.add", {
      name: "custom session to patch",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "session:project-alpha:ops",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
    });
    expect(validRes.ok).toBe(true);
    const jobId = (validRes.payload as { id?: unknown } | null)?.id;
    expect(typeof jobId).toBe("string");

    const updateRes = await directCronReq(cronState, "cron.update", {
      id: jobId,
      patch: {
        sessionTarget: "session:..\\outside",
      },
    });
    expect(updateRes.ok).toBe(true);
    expect(updateRes.payload).toMatchObject({ sessionTarget: "session:..\\outside" });
  });

  test("rejects malformed cron.webhookToken objects at startup", async () => {
    await setupCronTestRun();

    await writeCronConfig({
      cron: {
        webhookToken: {
          opaque: true,
        },
      },
    });

    await expect(startServerWithClient()).rejects.toThrow("cron.webhookToken: Invalid input");
  }, 45_000);
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
