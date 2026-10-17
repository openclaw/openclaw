// E2E: hook dispatch uses the shared cron budget without starving older cron work.
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
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

type HookResponse = Awaited<ReturnType<typeof postRequest>>;

type HeldModelServer = Awaited<ReturnType<typeof startHeldModelServer>>;

const instances: OpenClawTestInstance[] = [];
const modelServers: HeldModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

describe("Gateway hook concurrency", () => {
  it(
    "returns bounded reply disposition from real stub-model hook turns",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { instance, modelServer } = await startTestGateway("gateway-hook-completion");

      const privateVisibleReply = "private visible hook completion";
      modelServer.queueReply(privateVisibleReply);
      const visible = await postObservedHook(instance, "visible");
      expectCompletion(visible, "visible", privateVisibleReply);

      modelServer.queueReply("NO_REPLY");
      const silent = await postObservedHook(instance, "silent");
      expectCompletion(silent, "silent", "NO_REPLY");
    },
  );

  it(
    "bounds hooks and admits an older cron turn before a later hook",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { instance, modelServer } = await startTestGateway("gateway-hook-concurrency");
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
      await waitFor(() =>
        expect(responses.filter((response) => response?.status === 200)).toHaveLength(
          SHARED_BUDGET,
        ),
      );
      await waitFor(() => expect(responses.every(Boolean)).toBe(true));

      expect(responses.filter((response) => response?.status === 200)).toHaveLength(SHARED_BUDGET);
      const timedOut = responses.find((response) => response?.status === 503);
      expect(timedOut?.status).toBe(503);
      expect(JSON.parse(timedOut?.body ?? "{}")).toMatchObject({
        ok: false,
        error: "hook agent run did not start before admission timeout",
        runId: expect.any(String),
      });
      await waitFor(() => expect(modelServer.active(), instance.logs()).toBeGreaterThan(0));
      expect(modelServer.peak(), instance.logs()).toBeLessThanOrEqual(SHARED_BUDGET);
      expect(modelServer.requestCount(), instance.logs()).toBeLessThanOrEqual(SHARED_BUDGET + 1);

      // Fresh work must cross the same admission fence after capacity is released.
      const requestCountBeforeRelease = modelServer.requestCount();
      modelServer.releaseAll();
      await expect(Promise.all(requests)).resolves.toHaveLength(SHARED_BUDGET + 1);
      const afterRelease = await postHook(instance, SHARED_BUDGET + 1);
      expect(afterRelease.status, afterRelease.body).toBe(200);
      await waitFor(() =>
        expect(modelServer.requestCount()).toBeGreaterThan(requestCountBeforeRelease),
      );
      await waitFor(() => expect(modelServer.active()).toBe(0));

      // Releasing one saturated hook must admit the older cron sibling before the later hook.
      modelServer.hold();
      const fairnessRequestStart = modelServer.requestCount();
      const fairnessHooks = Array.from({ length: SHARED_BUDGET }, (_, offset) =>
        postHook(instance, FAIRNESS_HOOK_OFFSET + offset),
      );
      await waitFor(() =>
        expect(modelServer.requestCount()).toBe(fairnessRequestStart + SHARED_BUDGET),
      );
      expect(modelServer.active(), instance.logs()).toBe(SHARED_BUDGET);

      const addResult = await instance.cli([
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
      expect(addResult.code, addResult.stderr).toBe(0);
      const cronJob = JSON.parse(addResult.stdout) as { id?: string };
      expect(cronJob.id).toEqual(expect.any(String));

      const runResult = await instance.cli(["cron", "run", cronJob.id ?? ""]);
      expect(runResult.code, runResult.stderr).toBe(0);
      const cronRun = JSON.parse(runResult.stdout) as {
        enqueued?: boolean;
        ok?: boolean;
        runId?: string;
      };
      expect(cronRun).toMatchObject({
        enqueued: true,
        ok: true,
        runId: expect.any(String),
      });

      // Let acknowledged outer cron work enqueue cron-nested before the competing hook.
      await delay(1_000);
      const lateHook = postHook(instance, FAIRNESS_LATE_HOOK_INDEX);
      await delay(1_000);
      expect(modelServer.requestCount()).toBe(fairnessRequestStart + SHARED_BUDGET);
      expect(modelServer.active()).toBe(SHARED_BUDGET);

      modelServer.release(fairnessRequestStart);
      const cronProviderRequest = fairnessRequestStart + SHARED_BUDGET;
      await waitFor(() => expect(modelServer.requestCount()).toBe(cronProviderRequest + 1));
      expect(modelServer.requestBody(cronProviderRequest)).toContain(FAIRNESS_CRON_MARKER);
      expect(modelServer.requestBody(cronProviderRequest)).not.toContain(
        `hook concurrency request ${FAIRNESS_LATE_HOOK_INDEX}`,
      );

      modelServer.release(cronProviderRequest);
      const lateHookProviderRequest = cronProviderRequest + 1;
      await waitFor(() => expect(modelServer.requestCount()).toBe(lateHookProviderRequest + 1));
      expect(modelServer.requestBody(lateHookProviderRequest)).toContain(
        `hook concurrency request ${FAIRNESS_LATE_HOOK_INDEX}`,
      );
      expect(modelServer.peak(), instance.logs()).toBeLessThanOrEqual(SHARED_BUDGET);

      console.info(
        `[capacity-group-fairness-trace] ${JSON.stringify({
          afterOneHookRelease: "older-cron",
          afterCronRelease: "later-hook",
          peakProviderConcurrency: modelServer.peak(),
          queuedOrder: ["cron", "later-hook"],
          saturatedProviderRequests: SHARED_BUDGET,
        })}`,
      );

      modelServer.releaseAll();
      await expect(Promise.all(fairnessHooks)).resolves.toSatisfy((values: HookResponse[]) =>
        values.every((value) => value.status === 200),
      );
      await expect(lateHook).resolves.toMatchObject({ status: 200 });
      await waitForCronRun(instance, cronJob.id ?? "", cronRun.runId ?? "");
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
      await waitFor(() => expect(modelServer.requestCount()).toBeGreaterThan(requestCountBefore));
      await waitFor(() => expect(modelServer.active()).toBe(0));
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

function postHook(instance: OpenClawTestInstance, index: number): Promise<HookResponse> {
  return postRequest(instance, "concurrency", index);
}

function postObservedHook(instance: OpenClawTestInstance, id: string): Promise<HookResponse> {
  return postRequest(instance, "completion", id, true);
}

async function postRequest(
  instance: OpenClawTestInstance,
  kind: "concurrency" | "completion",
  id: string | number,
  waitForCompletion?: true,
) {
  const response = await fetch(`http://127.0.0.1:${instance.port}/hooks/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${instance.hookToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `hook-${kind}-${id}`,
    },
    body: JSON.stringify({
      message: `hook ${kind} request ${id}`,
      name: `Hook ${kind} ${id}`,
      sessionKey: `hook:${kind}:${id}`,
      sessionMode: "persistent",
      deliver: false,
      ...(waitForCompletion ? { waitForCompletion } : {}),
    }),
  });
  return { body: await response.text(), status: response.status };
}

function waitFor(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 20, timeout: 30_000 });
}

function expectCompletion(response: HookResponse, disposition: string, privateText: string) {
  expect(response.status, response.body).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    ok: true,
    runId: expect.any(String),
    completion: { status: "ok", replyDisposition: disposition },
  });
  expect(response.body).not.toContain(privateText);
}

async function startTestGateway(name: string) {
  const modelServer = await startHeldModelServer();
  modelServers.push(modelServer);
  const instance = await createOpenClawTestInstance({
    name,
    config: createTestConfig(modelServer.url),
    env: { OPENCLAW_SKIP_CRON: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
  });
  instances.push(instance);
  await instance.startGateway();
  // Prepare the real runtime before steady-state admission measurements.
  await warmGatewayHook(instance, modelServer);
  return { instance, modelServer };
}

async function startHeldModelServer() {
  const releases: ReturnType<typeof createDeferred>[] = [];
  const requestBodies: string[] = [];
  const replyTexts = new Map<number, string>();
  let holdRequests = false;
  let active = 0;
  let peak = 0;
  let requestCount = 0;
  const server = await startOpenAiResponsesModelServer({
    modelId: "hook-concurrency",
    bindError: "hook concurrency model server did not bind",
    onRequest: (request, response) =>
      handleModelRequest(request, response).catch((error: unknown) => {
        if (!response.destroyed) {
          throw error;
        }
      }),
  });

  async function handleModelRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let requestBody = "";
    for await (const chunk of request) {
      requestBody += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    }
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
        writeOpenAiResponsesText(response, {
          text: replyTexts.get(index) ?? `hook concurrency response ${index}`,
          messageId: `hook-concurrency-message-${index}`,
          responseId: `hook-concurrency-response-${index}`,
        });
      }
    } finally {
      active -= 1;
    }
  }

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
      const result = await instance.cli([
        "cron",
        "runs",
        "--id",
        jobId,
        "--run-id",
        runId,
        "--json",
      ]);
      expect(result.code, result.stderr).toBe(0);
      const history = JSON.parse(result.stdout) as {
        entries?: Array<{ runId?: string; status?: string }>;
      };
      expect(history.entries).toContainEqual(expect.objectContaining({ runId, status: "ok" }));
    },
    { interval: 200, timeout: 30_000 },
  );
}
