import { afterEach, expect, it, vi } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const WAIT_OPTS = { interval: 20, timeout: 30_000 };

type ModelServer = Awaited<ReturnType<typeof startModelServer>>;

const instances: OpenClawTestInstance[] = [];
const modelServers: ModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

it(
  "returns bounded reply disposition from real stub-model hook turns",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const modelServer = await startModelServer();
    modelServers.push(modelServer);
    const instance = await createOpenClawTestInstance({
      name: "gateway-hook-completion",
      config: {
        ...createOpenAiResponsesModelConfig({
          baseUrl: modelServer.url,
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
      },
      env: { OPENCLAW_SKIP_CRON: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
    });
    instances.push(instance);
    await instance.startGateway();
    await warmGatewayHook(instance, modelServer);
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

async function warmGatewayHook(
  instance: OpenClawTestInstance,
  modelServer: ModelServer,
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
) {
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

async function startModelServer() {
  let requestCount = 0;
  const replyTexts = new Map<number, string>();
  const server = await startOpenAiResponsesModelServer({
    modelId: "hook-concurrency",
    bindError: "hook concurrency model server did not bind",
    onRequest: async (_request, response) => {
      const index = requestCount++;
      writeOpenAiResponsesText(response, {
        text: replyTexts.get(index) ?? `hook concurrency response ${index}`,
        messageId: `hook-concurrency-message-${index}`,
        responseId: `hook-concurrency-response-${index}`,
      });
    },
  });
  return {
    queueReply: (text: string) => replyTexts.set(requestCount, text),
    requestCount: () => requestCount,
    url: server.baseUrl,
    close: server.close,
  };
}
