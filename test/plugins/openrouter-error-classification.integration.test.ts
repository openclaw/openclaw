import { createServer } from "node:http";
import type { AssistantMessage } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, expect, it, vi } from "vitest";
import { classifyAssistantFailoverReason } from "../../src/agents/embedded-agent-helpers/assistant-message-failures.js";
import { recoverAfterTransportDrop } from "../../src/agents/embedded-agent-runner/run/attempt-recovery.test-support.js";
import {
  resolveFailoverStatus,
  resolveModelFallbackError,
} from "../../src/agents/failover-error.js";
import { makeProviderModelFixture } from "../../src/agents/test-helpers/provider-model-fixture.js";
import { sleepWithAbort } from "../../src/infra/backoff.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import {
  closeHttpServer,
  listenLoopback,
  respondJson,
} from "../helpers/gateway-integration-fixtures.js";
import { loadBundledProviderPlugin } from "../helpers/media-generation/bundled-provider-builders.js";

vi.mock("../../src/infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

let providerOwner: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

beforeAll(async () => {
  providerOwner = await registerSingleProviderPlugin(await loadBundledProviderPlugin("openrouter"));
});

const model = makeProviderModelFixture<"openai-completions">({
  id: "example/model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "",
  input: ["text", "image"],
});

async function runAgainstOpenRouter(params: {
  message?: string;
  status?: number;
  event?: { choices: { index: number; delta: object; finish_reason: string }[]; error?: object };
}) {
  const server = createServer((request, response) => {
    request.resume();
    if (params.event) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(params.event)}\n\ndata: [DONE]\n\n`);
    } else {
      const status = params.status ?? 404;
      respondJson(response, { error: { code: status, message: params.message } }, status);
    }
  });
  const baseUrl = `${await listenLoopback(server)}/api/v1`;
  try {
    const assistant = await streamOpenAICompletions(
      { ...model, baseUrl },
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "test-key" },
    ).result();
    expect(assistant.stopReason).toBe("error");
    if (params.message) {
      expect(assistant.errorMessage).toContain(params.message);
    }
    return {
      assistant,
      reason: classifyAssistantFailoverReason(assistant, { providerOwner }),
    };
  } finally {
    await closeHttpServer(server);
  }
}

function recover(assistant: AssistantMessage) {
  vi.mocked(sleepWithAbort).mockClear();
  return recoverAfterTransportDrop({ assistant, providerOwner, noTools: true, replaySafe: true });
}

function expectRetryEffects(fixture: Awaited<ReturnType<typeof recover>>, count: number) {
  for (const effect of [
    fixture.continueFromCurrentTranscript,
    fixture.markOwnedTranscriptRetry,
    fixture.onAgentEvent,
    sleepWithAbort,
  ]) {
    expect.soft(effect).toHaveBeenCalledTimes(count);
  }
  expect.soft(fixture.failoverRetryController.transientRetryCount).toBe(count);
}

it.each([
  "Prompt tokens limit exceeded: 24338 > 16443. To increase, visit https://example.invalid/organizations/synthetic/settings/keys and adjust the key's total limit",
])("does not retry an HTTP 402 key budget rejection: %s", async (message) => {
  const result = await runAgainstOpenRouter({ status: 402, message });
  expect(result.assistant.errorMessage).toBe(`402 ${message}`);
  expect(JSON.parse(result.assistant.errorBody!)).toMatchObject({ code: 402, message });
  const fixture = await recover(result.assistant);
  expect.soft(result.reason).toBe("billing");
  expect.soft(fixture.recovery).toEqual({ action: "proceed" });
  expectRetryEffects(fixture, 0);
});

it("keeps genuine HTTP 429 recovery at fifteen same-model retries", async () => {
  const result = await runAgainstOpenRouter({
    status: 429,
    message: "Rate limit exceeded",
  });
  const fixture = await recover(result.assistant);
  expect(result.reason).toBe("rate_limit");
  const retryState = {
    action: "retry",
    lastRetryFailoverReason: "rate_limit",
  };
  expect(fixture.recovery).toMatchObject(retryState);
  for (let retry = 2; retry <= 15; retry++) {
    expect(await fixture.recover()).toMatchObject(retryState);
  }
  expect(await fixture.recover()).toEqual({ action: "proceed" });
  expectRetryEffects(fixture, 15);
  expect(fixture.onAgentEvent).toHaveBeenLastCalledWith({
    stream: "run_status",
    data: expect.objectContaining({
      phase: "retrying",
      reason: "rate_limit",
      attempt: 16,
      maxAttempts: 16,
    }),
  });
});

it.each([
  ["error", "server_error", 500, undefined],
  ["network_error", "timeout", 408, undefined],
  [
    "error",
    "rate_limit",
    429,
    {
      code: 429,
      message: "Rate limit exceeded",
      metadata: { error_type: "rate_limit_exceeded" },
    },
  ],
] as const)("classifies streamed %s as %s", async (finishReason, reason, status, error) => {
  const { assistant, reason: classification } = await runAgainstOpenRouter({
    event: {
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      ...(error ? { error } : {}),
    },
  });
  const errorMessage = `Provider finish_reason: ${finishReason}`;
  expect(assistant).toMatchObject({
    stopReason: "error",
    errorMessage: error ? expect.stringContaining(error.message) : errorMessage,
  });
  expect(classification).toBe(reason);
  expect(resolveFailoverStatus(reason)).toBe(status);
  if (reason !== "rate_limit") {
    expect(
      resolveModelFallbackError(new Error(assistant.errorMessage), {
        provider: model.provider,
        model: model.id,
      }),
    ).toMatchObject({ kind: "failover", error: { reason, status } });
  }
});

it("treats an image-capability 404 as a terminal format failure", async () => {
  const result = await runAgainstOpenRouter({
    message: "No endpoints found that support image input",
  });
  expect(result.reason).toBe("format");
});

it.each([
  [404, "No endpoints found for missing/model.", "model_not_found"],
  [403, "Key limit exceeded", "billing"],
] as const)("classifies HTTP %s %s as %s", async (status, message, reason) => {
  const result = await runAgainstOpenRouter({ status, message });
  expect(result.reason).toBe(reason);
});
