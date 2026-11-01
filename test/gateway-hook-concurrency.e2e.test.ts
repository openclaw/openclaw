// E2E: hook dispatch and cron complete inside the shared capacity budget.
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { readRequestText } from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const TEST_TIMEOUT_MS = 180_000;
const SHARED_BUDGET = 8;
const FAIRNESS_CRON_MARKER = "capacity group fairness cron marker";
const FAIRNESS_HOOK_OFFSET = 100;
const FAIRNESS_LATE_HOOK_INDEX = FAIRNESS_HOOK_OFFSET + SHARED_BUDGET;
const WAIT_OPTS = { interval: 20, timeout: 30_000 };

type HookResponse = {
  body: string;
  status: number;
};

type HeldModelServer = Awaited<ReturnType<typeof startHeldModelServer>>;

const instances: OpenClawTestInstance[] = [];
const modelServers: HeldModelServer[] = [];

async function startScenario(name: string) {
  const modelServer = await startHeldModelServer();
  modelServers.push(modelServer);
  const instance = await createOpenClawTestInstance({
    name,
    config: createTestConfig(modelServer.url),
    env: { OPENCLAW_SKIP_CRON: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
  });
  instances.push(instance);
  await instance.startGateway();
  await warmGatewayHook(instance, modelServer);
  return { instance, modelServer };
}

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Gateway hook concurrency", () => {
  it(
    "returns bounded reply disposition from real stub-model hook turns",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { instance, modelServer } = await startScenario("gateway-hook-completion");
      for (const [disposition, text] of [
        ["visible", "private visible hook completion"],
        ["silent", "NO_REPLY"],
      ] as const) {
        modelServer.queueReply(text);
        const response = await postHook(instance, disposition, true);
        expect(response.status, response.body).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          ok: true,
          runId: expect.any(String),
          completion: { status: "ok", replyDisposition: disposition },
        });
        expect(response.body).not.toContain(text);
      }
    },
  );

  it(
    "bounds hook admission and completes queued cron and hook turns",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { instance, modelServer } = await startScenario("gateway-hook-concurrency");
      modelServer.hold();

      const responses: Array<HookResponse | undefined> = Array.from({
        length: SHARED_BUDGET + 1,
      });
      const requests = responses.map((_, index) =>
        postHook(instance, index).then((response) => {
          responses[index] = response;
          return response;
        }),
      );
      await vi.waitFor(
        () =>
          expect(responses.filter((response) => response?.status === 200)).toHaveLength(
            SHARED_BUDGET,
          ),
        WAIT_OPTS,
      );
      await vi.waitFor(() => expect(responses.every(Boolean)).toBe(true), WAIT_OPTS);

      expect(responses.filter((response) => response?.status === 200)).toHaveLength(SHARED_BUDGET);
      const timedOut = responses.find((response) => response?.status === 503);
      expect(timedOut?.status).toBe(503);
      expect(JSON.parse(timedOut?.body ?? "{}")).toMatchObject({
        ok: false,
        error: "hook agent run did not start before admission timeout",
        runId: expect.any(String),
      });
      await vi.waitFor(
        () => expect(modelServer.active(), instance.logs()).toBeGreaterThan(0),
        WAIT_OPTS,
      );
      expect(modelServer.peak(), instance.logs()).toBeLessThanOrEqual(SHARED_BUDGET);
      expect(modelServer.requestCount(), instance.logs()).toBeLessThanOrEqual(SHARED_BUDGET + 1);

      // Completing the admitted work frees shared capacity. A fresh request
      // must then cross the same real Gateway admission fence.
      const requestCountBeforeRelease = modelServer.requestCount();
      modelServer.releaseAll();
      await expect(Promise.all(requests)).resolves.toHaveLength(SHARED_BUDGET + 1);
      const afterRelease = await postHook(instance, SHARED_BUDGET + 1);
      expect(afterRelease.status, afterRelease.body).toBe(200);
      await vi.waitFor(
        () => expect(modelServer.requestCount()).toBeGreaterThan(requestCountBeforeRelease),
        WAIT_OPTS,
      );
      await vi.waitFor(() => expect(modelServer.active()).toBe(0), WAIT_OPTS);

      // Saturate the real hook-dispatch lane again, then queue cron inner work
      // and a later hook against the same shared capacity.
      modelServer.hold();
      const fairnessRequestStart = modelServer.requestCount();
      const fairnessHooks = Array.from({ length: SHARED_BUDGET }, (_, offset) =>
        postHook(instance, FAIRNESS_HOOK_OFFSET + offset, true),
      );
      await vi.waitFor(
        () => expect(modelServer.requestCount()).toBe(fairnessRequestStart + SHARED_BUDGET),
        WAIT_OPTS,
      );
      expect(modelServer.active(), instance.logs()).toBe(SHARED_BUDGET);

      const cronJob = await cliJson<{ id?: string }>(instance, [
        "cron",
        "add",
        "--name",
        "capacity group fairness proof",
        "--every",
        "1h",
        "--session",
        "isolated",
        "--message",
        FAIRNESS_CRON_MARKER,
        "--no-deliver",
        "--json",
      ]);
      expect(cronJob.id).toEqual(expect.any(String));
      const cronRun = await cliJson<{
        enqueued?: boolean;
        ok?: boolean;
        runId?: string;
      }>(instance, ["cron", "run", cronJob.id ?? ""]);
      expect(cronRun).toMatchObject({
        enqueued: true,
        ok: true,
        runId: expect.any(String),
      });

      // The outer cron acknowledgment is not inner-lane admission. Observe both
      // contenders queued behind the occupied budget rather than sleeping.
      await waitForQueuedSharedLane(instance, "cron-nested", 0);
      const lateHook = postHook(instance, FAIRNESS_LATE_HOOK_INDEX, true);
      await waitForQueuedSharedLane(instance, "hook-dispatch", SHARED_BUDGET);
      expect(modelServer.requestCount()).toBe(fairnessRequestStart + SHARED_BUDGET);
      expect(modelServer.active()).toBe(SHARED_BUDGET);

      modelServer.release(fairnessRequestStart);
      const firstQueuedProviderRequest = fairnessRequestStart + SHARED_BUDGET;
      await vi.waitFor(
        () => expect(modelServer.requestCount()).toBe(firstQueuedProviderRequest + 1),
        WAIT_OPTS,
      );
      modelServer.release(firstQueuedProviderRequest);
      const secondQueuedProviderRequest = firstQueuedProviderRequest + 1;
      await vi.waitFor(
        () => expect(modelServer.requestCount()).toBe(secondQueuedProviderRequest + 1),
        WAIT_OPTS,
      );
      // Hooks are normal priority; cron is background. Exact bounded-priority
      // ordering is covered with a controlled clock in command-queue.capacity-groups.test.ts.
      // Here real preparation time may put cron on either side of that boundary,
      // but each contender must reach the provider exactly once, one freed slot at a time.
      const lateHookMarker = `hook concurrency request ${FAIRNESS_LATE_HOOK_INDEX}`;
      const admittedMarkers = [firstQueuedProviderRequest, secondQueuedProviderRequest].map(
        (index) =>
          [FAIRNESS_CRON_MARKER, lateHookMarker].filter((marker) =>
            modelServer.requestBody(index)?.includes(marker),
          ),
      );
      expect(admittedMarkers).toEqual(
        expect.arrayContaining([[FAIRNESS_CRON_MARKER], [lateHookMarker]]),
      );
      expect(modelServer.peak(), instance.logs()).toBeLessThanOrEqual(SHARED_BUDGET);

      modelServer.releaseAll();
      for (const response of await Promise.all([...fairnessHooks, lateHook])) {
        expect(response.status, response.body).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({ ok: true, completion: { status: "ok" } });
      }
      await waitForCronRun(instance, cronJob.id ?? "", cronRun.runId ?? "");
      expect(modelServer.requestCount()).toBe(fairnessRequestStart + SHARED_BUDGET + 2);
      expect(modelServer.active()).toBe(0);
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    ...createOpenAiResponsesModelConfig({
      baseUrl,
      providerId: "hook-concurrency",
      modelId: "hook-concurrency",
      reasoning: false,
      toolProfile: "minimal",
    }),
    hooks: {
      enabled: true,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
    },
  };
}

async function warmGatewayHook(
  instance: OpenClawTestInstance,
  modelServer: HeldModelServer,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestCountBefore = modelServer.requestCount();
    const response = await postHook(instance, -(attempt + 1));
    if (response.status === 200) {
      await vi.waitFor(
        () =>
          expect(modelServer.requestCount(), instance.logs()).toBeGreaterThan(requestCountBefore),
        WAIT_OPTS,
      );
      await vi.waitFor(() => expect(modelServer.active()).toBe(0), WAIT_OPTS);
      return;
    }
    expect(response.status, response.body).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: "hook agent run did not start before admission timeout",
    });
  }
  throw new Error("Gateway hook warmup did not reach the model after three attempts");
}

async function postHook(
  instance: OpenClawTestInstance,
  index: number | string,
  waitForCompletion = false,
): Promise<HookResponse> {
  const kind = typeof index === "number" ? "concurrency" : "completion";
  const response = await fetch(`http://127.0.0.1:${instance.port}/hooks/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${instance.hookToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `hook-${kind}-${index}`,
    },
    body: JSON.stringify({
      message: `hook ${kind} request ${index}`,
      name: `Hook ${kind} ${index}`,
      sessionKey: `hook:${kind}:${index}`,
      sessionMode: "persistent",
      deliver: false,
      waitForCompletion,
    }),
  });
  return {
    body: await response.text(),
    status: response.status,
  };
}

async function startHeldModelServer() {
  const releases: ReturnType<typeof createDeferred<void>>[] = [];
  const requestBodies: string[] = [];
  const replyTexts = new Map<number, string>();
  let holdRequests = false;
  let active = 0;
  let peak = 0;
  let requestCount = 0;
  const server = await startOpenAiResponsesModelServer({
    modelId: "hook-concurrency",
    bindError: "hook concurrency model server did not bind",
    onRequest: async (request, response) => {
      const requestBody = await readRequestText(request);
      const index = requestCount;
      requestCount += 1;
      requestBodies[index] = requestBody;
      const release = createDeferred();
      releases[index] = release;
      if (!holdRequests) {
        release.resolve();
      }
      active += 1;
      peak = Math.max(peak, active);
      try {
        await release.promise;
        if (!response.destroyed) {
          writeModelResponse(response, index, replyTexts.get(index));
        }
      } finally {
        active -= 1;
      }
    },
  });

  const releaseAll = () => {
    holdRequests = false;
    for (const release of releases) {
      release?.resolve();
    }
  };
  return {
    active: () => active,
    hold: () => {
      holdRequests = true;
    },
    peak: () => peak,
    queueReply: (text: string) => {
      replyTexts.set(requestCount, text);
    },
    release: (index: number) => {
      releases[index]?.resolve();
    },
    releaseAll,
    requestBody: (index: number) => requestBodies[index],
    requestCount: () => requestCount,
    url: server.baseUrl,
    close: async () => {
      releaseAll();
      await server.close();
    },
  };
}

async function waitForCronRun(
  instance: OpenClawTestInstance,
  jobId: string,
  runId: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const history = await cliJson<{ entries?: Array<{ runId?: string; status?: string }> }>(
        instance,
        ["cron", "runs", "--id", jobId, "--run-id", runId, "--json"],
      );
      expect(history.entries).toContainEqual(expect.objectContaining({ runId, status: "ok" }));
    },
    { interval: 200, timeout: 30_000 },
  );
}

async function waitForQueuedSharedLane(
  instance: OpenClawTestInstance,
  lane: string,
  activeCount: number,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const diagnostics = await cliJson<{ lanes: unknown[] }>(instance, [
        "gateway",
        "call",
        "diagnostics.lanes",
        "--json",
      ]);
      expect(diagnostics.lanes).toContainEqual(
        expect.objectContaining({
          lane,
          activeCount,
          queuedCount: 1,
          group: "cron-hooks",
          groupActive: SHARED_BUDGET,
          groupBudget: SHARED_BUDGET,
        }),
      );
    },
    { interval: 200, timeout: 30_000 },
  );
}

async function cliJson<T>(instance: OpenClawTestInstance, args: string[]): Promise<T> {
  const result = await instance.cli(args);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

function writeModelResponse(response: ServerResponse, sequence: number, replyText?: string): void {
  const text = replyText ?? `hook concurrency response ${sequence}`;
  writeOpenAiResponsesText(response, {
    text,
    messageId: `hook-concurrency-message-${sequence}`,
    responseId: `hook-concurrency-response-${sequence}`,
  });
}
