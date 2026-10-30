// Gateway cron integration tests cover RPC projection, authority, runs, and webhook delivery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type * as CronDelivery from "../cron/delivery.js";
import { readCronRunRecordsForTests } from "../cron/run-history.test-support.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import { resolveCronJobsStorePathFromConfigAsync } from "../cron/store/paths.js";
import type { CronJobCreate } from "../cron/types.js";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { getGatewayProcessInstanceId } from "./process-instance.js";
import type { GatewayCronState } from "./server-cron-contract.js";
import {
  cleanupCronTestRun,
  expectEnqueuedRunPayload,
  installCronSystemEventConsumer,
  makeCronJob,
  runCronJobAndWaitForFinished,
  waitForCronEvent,
} from "./server-cron.events.test-support.js";
import { registerCronRepairCases } from "./server.cron-repair.cases.js";
import {
  expectCronJobIdFromResponse,
  expectCronRows as rows,
} from "./server.cron.assertions.test-support.js";
import {
  agentCommandMock,
  connectOk,
  cronIsolatedRun,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
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
  vi.fn<typeof CronDelivery.sendCronAnnouncePayloadStrict>(async ({ payload }) => ({
    status: "sent",
    payloads: Array.isArray(payload) ? payload : [payload],
  })),
);

// mock-isolation: Record webhook delivery without issuing real network requests.
vi.mock("../infra/net/fetch-guard.js", () => ({ fetchWithSsrFGuard: fetchWithSsrFGuardMock }));

vi.mock("../cron/delivery.js", async () => {
  const actual = await vi.importActual<typeof CronDelivery>("../cron/delivery.js");
  return { ...actual, sendCronAnnouncePayloadStrict: sendCronAnnouncePayloadStrictMock };
});

installGatewayTestHooks({ scope: "suite" });
let cronSuiteTempRoot: string;
let cronSuiteCaseId = 0;
let caseDir: string;

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

let activeCronRun: Parameters<typeof cleanupCronTestRun>[0] | undefined;
let disposeCronEventConsumer: (() => void) | undefined;

async function startCronClient() {
  const { server, ws } = await startServerWithClient();
  Object.assign(expectDefined(activeCronRun, "cron setup"), { server, ws });
  await connectOk(ws);
  return {
    ws,
    request: (method: string, params: Record<string, unknown>, timeoutMs?: number) =>
      rpcReq(ws, method, params, timeoutMs),
    add: (name: string, options: Omit<Parameters<typeof addWebhookCronJob>[0], "ws" | "name">) =>
      addWebhookCronJob({ ws, name, ...options }),
    waitForJob: (jobId: string, action = "finished") =>
      waitForCronEvent(ws, (event) => event?.jobId === jobId && event?.action === action),
    run: (jobId: string) => runCronJobAndWaitForFinished(ws, jobId),
  };
}

async function setupCronTestRun() {
  const prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
  activeCronRun = { prevSkipCron };
  process.env.OPENCLAW_SKIP_CRON = "0";
  const dir = path.join(cronSuiteTempRoot, `case-${cronSuiteCaseId++}`);
  const storePath = path.join(dir, "cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  testState.cronStorePath = storePath;
  testState.sessionConfig = undefined;
  testState.cronEnabled = false;
  testState.cronTriggersEnabled = undefined;
  await saveCronStore(storePath, { version: 1, jobs: [] });
  caseDir = dir;
}

type DirectCronState = GatewayCronState & {
  getRuntimeConfig: () => import("../config/types.openclaw.js").OpenClawConfig;
  request: (method: string, params: Record<string, unknown>) => Promise<DirectCronResponse>;
  addJob: (name: string, overrides?: Partial<CronJobCreate>) => Promise<DirectCronResponse>;
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
  const cfg = getRuntimeConfig();
  const storePath = await resolveCronJobsStorePathFromConfigAsync(cfg);
  const cronState: DirectCronState = {
    ...buildGatewayCronService({
      scheduler: createTestGatewayScheduler({
        ...createGatewaySchedulerClock().clock,
        now: () => Date.now(),
      }),
      cfg,
      storePath,
      deps: {} as never,
      broadcast: params?.broadcast ?? vi.fn(),
    }),
    getRuntimeConfig,
    request: (method, requestParams) => directCronReq(cronState, method, requestParams),
    addJob: (name, overrides) => directCronReq(cronState, "cron.add", makeCronJob(name, overrides)),
  };
  expectDefined(activeCronRun, "cron setup").cronState = cronState;
  return cronState;
}

function createCronEventCollector(signal: AbortSignal) {
  const events: Record<string, unknown>[] = [];
  const waiters = new Set<(payload: Record<string, unknown>) => void>();
  return {
    broadcast: (event: string, payload: unknown) => {
      if (event !== "cron" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return;
      }
      const record = payload as Record<string, unknown>;
      events.push(record);
      for (const notify of waiters) {
        notify(record);
      }
    },
    async wait(check: (payload: Record<string, unknown>) => boolean) {
      const existing = events.find(check);
      if (existing) {
        return existing;
      }
      const result = createDeferred<Record<string, unknown>>();
      const notify = (payload: Record<string, unknown>) => {
        if (check(payload)) {
          waiters.delete(notify);
          result.resolve(payload);
        }
      };
      waiters.add(notify);
      try {
        return await withinTest(result.promise, signal);
      } finally {
        waiters.delete(notify);
      }
    },
  };
}

async function directCronReq(
  cronState: DirectCronState,
  method: string,
  params: Record<string, unknown>,
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
      client: null,
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

async function addWebhookCronJob(params: {
  ws: WebSocket;
  name: string;
  sessionTarget?: "main" | "isolated";
  payloadText?: string;
  delivery: Record<string, unknown>;
  failureAlert?: Record<string, unknown>;
}) {
  const { ws, name, sessionTarget = "main", payloadText, delivery, failureAlert } = params;
  const response = await rpcReq(ws, "cron.add", {
    ...makeCronJob(name, {
      sessionTarget,
      payload:
        sessionTarget === "isolated"
          ? { kind: "agentTurn", message: payloadText ?? "test" }
          : { kind: "systemEvent", text: payloadText ?? "send webhook" },
    }),
    delivery,
    ...(failureAlert ? { failureAlert } : {}),
  });
  return expectCronJobIdFromResponse(response);
}

function expectWebhook(index: number, url: string, jobId: string, summary: string) {
  const call = getWebhookCall(index);
  expect(call).toMatchObject({ url, method: "POST" });
  expect(call.headers.get("Authorization")).toBe("Bearer cron-webhook-token");
  expect(call.body).toMatchObject({ action: "finished", jobId, summary });
  return call;
}

async function writeCronConfig(config: unknown) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  expect(typeof configPath).toBe("string");
  await fs.mkdir(path.dirname(configPath as string), { recursive: true });
  await fs.writeFile(configPath as string, JSON.stringify(config, null, 2), "utf-8");
  resetConfigRuntimeState();
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

function holdIsolatedRun() {
  const entered = createDeferred();
  const result = createDeferred<{ status: "ok"; summary: string }>();
  cronIsolatedRun.mockImplementationOnce(() => {
    entered.resolve();
    return result.promise;
  });
  return {
    entered: entered.promise,
    finish: (summary: string) => result.resolve({ status: "ok", summary }),
  };
}

describe("gateway server cron", () => {
  beforeAll(async () => {
    cronSuiteTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-suite-"));
    await Promise.all([
      import("../config/config.js"),
      import("./server-cron.js"),
      import("./server-methods/cron.js"),
    ]);
  });

  afterAll(async () => {
    await rmTempDir(cronSuiteTempRoot);
  });

  afterEach(async () => {
    const run = activeCronRun;
    activeCronRun = undefined;
    try {
      if (run) {
        await cleanupCronTestRun(run);
      }
    } finally {
      disposeCronEventConsumer?.();
      disposeCronEventConsumer = undefined;
    }
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    resetConfigRuntimeState();
  });

  beforeEach(async () => {
    // Keep polling helpers deterministic even if other tests left fake timers enabled.
    vi.useRealTimers();
    sendCronAnnouncePayloadStrictMock.mockClear();
    await setupCronTestRun();
  });

  test("broadcasts cron attention state without repeating job definitions", async () => {
    const { ws, request, run } = await startCronClient();
    disposeCronEventConsumer = await installCronSystemEventConsumer();
    const text = "Synthetic scheduled inspection. ".repeat(512).trim();
    const addedEvent = waitForCronEvent(ws, (event) => event?.action === "added");
    const response = await request(
      "cron.add",
      makeCronJob("compact cron event", { payload: { kind: "systemEvent", text } }),
    );
    const jobId = expectCronJobIdFromResponse(response);
    const added = await addedEvent;
    expect(added).toMatchObject({
      action: "added",
      jobId,
      job: {
        id: jobId,
        name: "compact cron event",
        enabled: true,
        updatedAtMs: expect.any(Number),
        state: { nextRunAtMs: expect.any(Number) },
      },
    });
    expect(added?.job).not.toHaveProperty("payload");
    expect(added?.job).not.toHaveProperty("schedule");
    expect(Buffer.byteLength(JSON.stringify(added))).toBeLessThan(1_024);
    const current = await request("cron.get", { id: jobId });
    expect(current.payload).toMatchObject({ payload: { kind: "systemEvent", text } });

    const finished = await run(jobId);
    expect(finished).toMatchObject({
      jobId,
      action: "finished",
      status: "ok",
      job: { id: jobId, state: { lastRunStatus: "ok", lastRunAtMs: expect.any(Number) } },
    });
    expect(finished?.job).not.toHaveProperty("payload");
    expect(finished?.job).not.toHaveProperty("schedule");
    expect(finished).not.toHaveProperty("summary");
    expect(Buffer.byteLength(JSON.stringify(finished))).toBeLessThan(1_024);

    const removedEvent = waitForCronEvent(
      ws,
      (event) => event?.action === "removed" && event.jobId === jobId,
    );
    expect((await request("cron.remove", { id: jobId })).ok).toBe(true);
    const removed = await removedEvent;
    expect(removed?.job).toMatchObject({ id: jobId, name: "compact cron event" });
    expect(removed?.job).not.toHaveProperty("payload");
  });

  test("does not persist cron.add when the delivery preview cannot be resolved", async () => {
    testState.sessionStorePath = path.join(caseDir, "invalid.sqlite");
    await fs.writeFile(testState.sessionStorePath, "not a SQLite database");
    const cronState = await createDirectCronState();

    const response = await cronState.request("cron.add", {
      name: "preview failure",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "check status" },
    });

    expect(response.ok).toBe(false);
    expect(await cronState.cron.list({ includeDisabled: true })).toHaveLength(0);
  });

  test("atomically rejects stale config revisions without conflicting on runtime state", async () => {
    const cronState = await createDirectCronState();

    const added = await cronState.addJob("revision protected", {
      payload: { kind: "systemEvent", text: "original" },
    });
    expect(added.ok).toBe(true);
    const addedJob = added.payload as { id: string };
    const initial = await cronState.request("cron.get", { id: addedJob.id });
    const initialJob = initial.payload as {
      id: string;
      configRevision: string;
      updatedAtMs: number;
    };

    const runtimeOnly = await cronState.request("cron.update", {
      id: initialJob.id,
      patch: { state: { lastRunAtMs: 1_700_000_000_000 } },
    });
    expect(runtimeOnly.ok).toBe(true);
    expect(runtimeOnly.payload).toMatchObject({ configRevision: initialJob.configRevision });

    const first = await cronState.request("cron.update", {
      id: initialJob.id,
      expectedConfigRevision: initialJob.configRevision,
      patch: { description: "first writer" },
    });
    expect(first.ok).toBe(true);
    const firstJob = first.payload as { configRevision: string; updatedAtMs: number };
    expect(firstJob.configRevision).not.toBe(initialJob.configRevision);
    expect(firstJob.updatedAtMs).toBeGreaterThan(initialJob.updatedAtMs);

    const stale = await cronState.request("cron.update", {
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

    const current = await cronState.request("cron.get", { id: initialJob.id });
    expect(current.payload).toMatchObject({
      description: "first writer",
      updatedAtMs: firstJob.updatedAtMs,
    });
  });

  test("preserves an explicit main-session owner and rejects invalid chat delivery after default drift", async () => {
    await writeCronConfig({
      session: { mainKey: "main" },
      agents: { entries: { ops: {} } },
      channels: { telegram: { botToken: "telegram-token" } },
    });

    const cronState = await createDirectCronState();

    const addRes = await cronState.addJob("main default agent drift", { agentId: "ops" });
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

    const before = await cronState.request("cron.get", { id: jobId });
    const updateRes = await cronState.request("cron.update", {
      id: jobId,
      patch: {
        name: "must not persist",
        delivery: { mode: "announce", channel: "telegram", to: "19098680" },
      },
    });

    expect(updateRes.ok).toBe(false);
    expect(updateRes.error?.message).toContain("cron channel delivery config");
    expect(await cronState.request("cron.get", { id: jobId })).toEqual(before);

    const renamed = await cronState.request("cron.update", {
      id: jobId,
      patch: { name: "renamed after default drift" },
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.payload).toMatchObject({ name: "renamed after default drift", agentId: "ops" });

    for (const bindingPatch of [
      { agentId: "ops" },
      { sessionTarget: "main" },
      { payload: { kind: "systemEvent", text: "new work" } },
    ]) {
      const retargeted = await cronState.request("cron.update", {
        id: jobId,
        patch: { name: "retained explicit owner", ...bindingPatch },
      });
      expect(retargeted.ok, retargeted.error?.message).toBe(true);
      expect(retargeted.payload).toMatchObject({
        name: "retained explicit owner",
        agentId: "ops",
        sessionTarget: "main",
      });
      expect(await cronState.request("cron.get", { id: jobId })).toEqual(retargeted);
    }
  });

  test("writes cron run history and auto-runs due jobs", async ({ signal }) => {
    testState.cronEnabled = true;
    await writeCronConfig({
      agents: { defaults: { systemAgent: { agentId: "main" } }, entries: { main: {}, writer: {} } },
    });
    const events = createCronEventCollector(signal);
    const cronState = await createDirectCronState({ broadcast: events["broadcast"] });

    disposeCronEventConsumer = await installCronSystemEventConsumer();

    const addRes = await cronState.addJob("log test");
    const jobId = expectCronJobIdFromResponse(addRes);

    const finishedRun = events.wait(
      (payload) => payload?.jobId === jobId && payload?.action === "finished",
    );
    const runRes = await cronState.request("cron.run", { id: jobId, mode: "force" });
    expect(runRes.ok).toBe(true);
    expectEnqueuedRunPayload(runRes.payload);
    const manualRunId = (runRes.payload as { runId?: unknown } | null)?.runId;
    expect(typeof manualRunId).toBe("string");
    const finishedPayload = await finishedRun;
    expect(finishedPayload).toMatchObject({
      jobId,
      action: "finished",
      status: "ok",
      deliveryStatus: "not-requested",
    });

    const runsRes = await cronState.request("cron.runs", { id: jobId, limit: 50 });
    expect(rows(runsRes).at(-1)).toMatchObject({
      jobId,
      jobName: "log test",
      summary: "hello",
      deliveryStatus: "not-requested",
      runId: manualRunId,
    });
    const allRunsRes = await cronState.request("cron.runs", {
      scope: "all",
      limit: 50,
      statuses: ["ok"],
    });
    expect(rows(allRunsRes)).toContainEqual(expect.objectContaining({ jobId }));

    const writerAddResult = await cronState.cron.add(
      makeCronJob("writer log test", {
        agentId: "writer",
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "writer hello" },
      }),
    );
    const writerJobId = ("job" in writerAddResult ? writerAddResult.job : writerAddResult).id;
    const writerFinished = events.wait(
      (payload) => payload?.jobId === writerJobId && payload?.action === "finished",
    );
    const writerRun = await cronState.request("cron.run", { id: writerJobId, mode: "force" });
    expect(writerRun.ok).toBe(true);
    await writerFinished;

    const mainRuns = await cronState.request("cron.runs", { scope: "all", agentId: "main" });
    const writerRuns = await cronState.request("cron.runs", { scope: "all", agentId: "writer" });
    expect(rows(mainRuns)).not.toContainEqual(expect.objectContaining({ jobId: writerJobId }));
    expect(rows(writerRuns)).toContainEqual(expect.objectContaining({ jobId: writerJobId }));

    const removeWriter = await cronState.request("cron.remove", { id: writerJobId });
    expect(removeWriter.ok).toBe(true);
    expect(readCronRunRecordsForTests(writerJobId)).toEqual([
      expect.objectContaining({ jobId: writerJobId, agentId: "writer" }),
    ]);
    const retainedWriterRuns = await cronState.request("cron.runs", {
      scope: "all",
      agentId: "writer",
    });
    expect(retainedWriterRuns.payload).toMatchObject({
      entries: [expect.objectContaining({ jobId: writerJobId })],
      total: 1,
    });

    const statusRes = await cronState.request("cron.status", {});
    expect(statusRes.ok).toBe(true);
    expect(statusRes.payload).toMatchObject({
      enabled: true,
      storePath: expect.stringContaining("openclaw.sqlite"),
    });

    // Exercise live dispatch; overdue work at startup intentionally waits for recovery pacing.
    await cronState.cron.start();
    const autoRes = await cronState.addJob("auto run test", {
      schedule: { kind: "at", at: new Date(Date.now() - 1).toISOString() },
      payload: { kind: "systemEvent", text: "auto" },
    });
    const autoJobId = expectCronJobIdFromResponse(autoRes);

    const autoFinished = events.wait(
      (payload) => payload?.jobId === autoJobId && payload?.action === "finished",
    );
    await autoFinished;
    const autoRuns = rows(await cronState.request("cron.runs", { id: autoJobId, limit: 10 }));
    expect(autoRuns.at(-1)).toMatchObject({ jobId: autoJobId });
  }, 45_000);

  test("bundled plugin runtime runs enabled automations and skips disabled ones", async ({
    signal,
  }) => {
    testState.cronEnabled = true;
    const events = createCronEventCollector(signal);
    const cronState = await createDirectCronState({ broadcast: events["broadcast"] });
    disposeCronEventConsumer = await installCronSystemEventConsumer();

    const addRes = await cronState.addJob("plugin runtime nudge", {
      schedule: { kind: "cron", expr: "0 3 1 1 *", tz: "America/Los_Angeles" },
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
    await expect(finishedRun).resolves.toMatchObject({ jobId, action: "finished", status: "ok" });
    const runsRes = await cronState.request("cron.runs", { id: jobId, limit: 5 });
    expect(rows(runsRes)).toEqual([expect.objectContaining({ jobId })]);

    const disabledAddRes = await cronState.addJob("disabled plugin runtime nudge", {
      enabled: false,
      schedule: { kind: "cron", expr: "0 3 1 1 *", tz: "America/Los_Angeles" },
      payload: { kind: "systemEvent", text: "disabled plugin runtime nudge" },
    });
    const disabledJobId = expectCronJobIdFromResponse(disabledAddRes);
    await expect(runThroughPlugin(disabledJobId)).resolves.toMatchObject({
      ok: true,
      ran: false,
      reason: "disabled",
    });
    const disabledRuns = await cronState.request("cron.runs", { id: disabledJobId, limit: 5 });
    expect(rows(disabledRuns)).toEqual([]);
  });

  test("cron.run waitTimeoutMs returns the finished run, or only its runId when the wait ends first", async () => {
    const held = holdIsolatedRun();
    const { request, add, waitForJob } = await startCronClient();
    const jobId = await add("waited job", {
      sessionTarget: "isolated",
      payloadText: "report",
      delivery: { mode: "none" },
    });

    const pending = await request("cron.run", { id: jobId, waitTimeoutMs: 50 }, 5_000);
    expect(pending.ok).toBe(true);
    expect(pending.payload).toEqual({
      ok: true,
      enqueued: true,
      runId: expect.any(String),
      processInstanceId: getGatewayProcessInstanceId(),
    });
    await held.entered;
    const slowFinished = waitForJob(jobId);
    held.finish("late report");
    await slowFinished;

    cronIsolatedRun.mockResolvedValueOnce({ status: "ok", summary: "waited report" });
    const done = await request("cron.run", { id: jobId, waitTimeoutMs: 10_000 }, 15_000);
    expect(done.ok).toBe(true);
    const runId = expectEnqueuedRunPayload(done.payload);
    expect(done.payload).toMatchObject({
      run: { runId, status: "ok", completionStatus: "succeeded", summary: "waited report" },
    });
  });

  test("returns already-running without starting background work", async () => {
    const held = holdIsolatedRun();

    const { request, add, waitForJob } = await startCronClient();

    // Minimal Gateway startup skips cron recovery; finish it before the timed requests.
    const { getGatewayLifecycleRuntime } = await import("./server-lifecycle-runtime-context.js");
    const runtime = expectDefined(getGatewayLifecycleRuntime(), "Gateway runtime");
    const resolveContext = expectDefined(getGatewayContextResolver(runtime), "Gateway context");
    await expectDefined(resolveContext(), "Gateway context").cron.start();

    const jobId = await add("busy job", {
      sessionTarget: "isolated",
      payloadText: "still busy",
      delivery: { mode: "none" },
    });
    const startedRun = waitForJob(jobId, "started");
    const firstRunRes = await request("cron.run", { id: jobId, mode: "force" }, 1_000);
    expect(firstRunRes.ok).toBe(true);
    expectEnqueuedRunPayload(firstRunRes.payload);
    await Promise.all([startedRun, held.entered]);
    expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

    const secondRunRes = await request("cron.run", { id: jobId, mode: "force" }, 1_000);
    expect(secondRunRes.ok).toBe(true);
    expect(secondRunRes.payload).toEqual({
      ok: true,
      ran: false,
      reason: "already-running",
      processInstanceId: getGatewayProcessInstanceId(),
    });
    expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

    const finishedRun = waitForJob(jobId);
    held.finish("busy done");
    await finishedRun;
  });

  test("posts authenticated primary and completion webhooks", async () => {
    await writeCronConfig({
      cron: { webhookToken: "cron-webhook-token", failureAlert: { after: 1 } },
    });

    fetchWithSsrFGuardMock.mockClear();

    const { request, add, run } = await startCronClient();

    disposeCronEventConsumer = await installCronSystemEventConsumer("send webhook");

    const notifyJobId = await add("webhook enabled", {
      delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
    });
    const notifyFinished = await run(notifyJobId);
    const notifyCall = expectWebhook(
      0,
      "https://example.invalid/cron-finished",
      notifyJobId,
      "send webhook",
    );
    expect(notifyCall.headers.get("Content-Type")).toBe("application/json");
    expect(notifyFinished).toMatchObject({
      status: "ok",
      delivered: true,
      deliveryStatus: "delivered",
    });

    const notifyRuns = await request("cron.runs", { id: notifyJobId, limit: 10 });
    expect(rows(notifyRuns).at(-1)).toMatchObject({
      deliveryStatus: "delivered",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);

    const completionJobId = await add("announce plus completion webhook", {
      sessionTarget: "isolated",
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "https://example.invalid/completion-destination",
        },
      },
    });
    await run(completionJobId);
    expectWebhook(1, "https://example.invalid/completion-destination", completionJobId, "ok");
  }, 60_000);

  test("omits raw summaries from failed cron webhook payloads", async () => {
    await writeCronConfig({ cron: { webhookToken: "cron-webhook-token" } });

    fetchWithSsrFGuardMock.mockClear();
    const { add, run } = await startCronClient();

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
    const directJobId = await add("failed direct webhook", {
      sessionTarget: "isolated",
      delivery: { mode: "webhook", to: "https://example.invalid/failed-direct" },
    });
    await run(directJobId);
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
    // Delivery persistence is independent of cold fallback-session creation and runtime preparation.
    testState.sessionStorePath = path.join(caseDir, "sessions.json");
    await writeSessionStore({
      entries: { main: { sessionId: "cron-failure-alert-session", updatedAt: Date.now() } },
    });
    const { request, add, run } = await startCronClient();
    await prepareGatewayReplyRuntimeForTest({ force: true });

    const expectOutcome = async (jobId: string, expected: Record<string, unknown>) => {
      await vi.waitFor(async () => {
        const getResult = await request("cron.get", { id: jobId });
        expect(getResult.payload).toMatchObject(expected);
        for (const compact of [false, true]) {
          const listResult = await request("cron.list", {
            compact,
            includeDeliveryPreviews: false,
          });
          const listed = rows(listResult, "jobs").find((job) => job.id === jobId);
          expect(listed).toMatchObject(expected);
        }
      });
    };
    const runFailureAlert = async (name: string, failureAlert: Record<string, unknown>) => {
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", error: "job failed" });
      const jobId = await add(name, {
        sessionTarget: "isolated",
        delivery: { mode: "none" },
        failureAlert: { after: 1, ...failureAlert },
      });
      await run(jobId);
      return jobId;
    };

    for (const outcome of ["delivered", "failed", "unreached"] as const) {
      const error = outcome === "failed" ? "alert transport rejected" : "adapter_returned_no_send";
      if (outcome === "failed") {
        fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error(error));
      } else if (outcome === "unreached") {
        sendCronAnnouncePayloadStrictMock.mockImplementationOnce(async (params) => {
          params.onDeliveryAttempt?.(false);
          return { status: "suppressed", reason: "adapter_returned_no_send" };
        });
      }
      const jobId = await runFailureAlert(
        `${outcome} failure alert`,
        outcome === "unreached"
          ? { mode: "announce", channel: "telegram", to: "123" }
          : { mode: "webhook", to: `https://example.invalid/${outcome}-failure-alert` },
      );
      await expectOutcome(jobId, {
        lastFailureNotificationDelivered: outcome === "delivered",
        lastFailureNotificationDeliveryStatus:
          outcome === "delivered" ? "delivered" : "not-delivered",
        ...(outcome === "delivered"
          ? {}
          : { lastFailureNotificationDeliveryError: expect.stringContaining(error) }),
      });
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  }, 45_000);
  test("rejects malformed cron payload and trigger scripts before persistence", async () => {
    testState.cronEnabled = true;
    const cronState = await createDirectCronState();

    const response = await cronState.addJob("malformed script", {
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "script", script: "const x = ;" },
    });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("INVALID_REQUEST");
    expect(response.error?.message).toContain(
      "cron script payload has a syntax error: Unexpected token (line 1, column 10)",
    );

    const triggerInput = makeCronJob("condition watcher", {
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "changed" },
    });
    const invalidTrigger = { script: "const x = ;" };
    const expectedTriggerError =
      "cron trigger script has a syntax error: Unexpected token (line 1, column 10)";
    const invalidCreate = await cronState.request("cron.add", {
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
    const created = await cronState.request("cron.add", { ...triggerInput, trigger: validTrigger });
    const jobId = expectCronJobIdFromResponse(created);
    const invalidUpdate = await cronState.request("cron.update", {
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

  registerCronRepairCases(() => caseDir, startCronClient, sendCronAnnouncePayloadStrictMock);

  test.for(["success", "error"] as const)(
    "keeps owner-topic repair pending through retries until the agent turn settles with %s",
    { timeout: 45_000 },
    async (outcome, { signal }) => {
      testState.cronEnabled = true;
      const group = "-100155462274";
      const ownerSessionKey = `agent:main:telegram:group:${group}:topic:42`;
      const hour = new Date().getUTCHours();
      testState.agentConfig = { timeoutSeconds: 91 };
      testState.sessionStorePath = path.join(caseDir, "sessions.json");
      await writeSessionStore({
        agentId: "main",
        entries: {
          [ownerSessionKey]: {
            sessionId: "owner-topic-session",
            updatedAt: Date.now(),
            chatType: "group",
            deliveryContext: { channel: "telegram", to: group, threadId: 42 },
            lastChannel: "telegram",
            lastTo: group,
            lastThreadId: 42,
          },
        },
      });
      const { request, run } = await startCronClient();
      // The retired heartbeat is an ordinary automation; its window and target must
      // not constrain an independent repair turn in the owner's conversation.
      const proactive = await request(
        "cron.add",
        makeCronJob("Independent periodic check", {
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Check pending work." },
          delivery: { mode: "none" },
          activeHours: {
            start: `${String((hour + 2) % 24).padStart(2, "0")}:00`,
            end: `${String((hour + 3) % 24).padStart(2, "0")}:00`,
            timezone: "UTC",
          },
          idleOnly: true,
        }),
      );
      expect(proactive.ok, JSON.stringify(proactive.error ?? null)).toBe(true);
      await prepareGatewayReplyRuntimeForTest({ force: true });
      const repairTurnStarted = createDeferred();
      const finishRepairTurn = createDeferred();
      agentCommandMock.mockImplementationOnce(async () => {
        repairTurnStarted.resolve();
        await finishRepairTurn.promise;
        if (outcome === "error") {
          throw new Error("repair command failed");
        }
      });
      cronIsolatedRun.mockResolvedValue({ status: "error", error: "scripts/sync.md is missing" });
      const added = await request(
        "cron.add",
        makeCronJob("meeting sync", {
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Follow scripts/sync.md." },
          delivery: { mode: "announce", channel: "telegram", to: group, threadId: 42 },
          owner: { agentId: "main", sessionKey: ownerSessionKey },
        }),
      );
      expect(added.ok, JSON.stringify(added.error ?? null)).toBe(true);
      const jobId = expectCronJobIdFromResponse(added);

      try {
        await run(jobId);
        await run(jobId);

        await withinTest(repairTurnStarted.promise, signal);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        // The owner topic's own session and route: no periodic-job session or runtime warnings.
        expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
          sessionKey: ownerSessionKey,
          deliver: true,
          channel: "telegram",
          to: group,
          threadId: 42,
          message: expect.stringContaining("Automation repair request from the scheduler"),
          internalDeliverySuppressErrors: true,
        });

        // Dispatch acceptance is not repair completion: a retry while the turn is held
        // cannot verify its changes or consume the incident's one escalation.
        await run(jobId);
        const pending = await request("cron.get", { id: jobId });
        expect(pending.ok).toBe(true);
        expect(pending.payload).toMatchObject({
          state: { lastFailureNotificationDeliveryStatus: "not-requested" },
        });
        expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(cronIsolatedRun).toHaveBeenCalledTimes(3);
        expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({ timeout: "91" });
      } finally {
        finishRepairTurn.resolve();
      }
      await vi.waitFor(async () => {
        const stored = await loadCronStore(path.join(caseDir, "cron", "jobs.json"));
        const repair = stored.jobs.find((job) => job.id === jobId)?.state.failureAlertIncident
          ?.repair;
        expect(repair?.settledAtMs).toEqual(expect.any(Number));
      });
      await run(jobId);
      await vi.waitFor(() => expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce());
      await run(jobId);
      expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce();
    },
  );
});
