import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { classifyAssistantFailoverReason } from "../../src/agents/embedded-agent-helpers/assistant-message-failures.js";
import { formatAssistantErrorText } from "../../src/agents/embedded-agent-helpers/error-text.js";
import { recoverAfterTransportDrop } from "../../src/agents/embedded-agent-runner/run/attempt-recovery.test-support.js";
import {
  resolveFailoverStatus,
  resolveModelFallbackError,
} from "../../src/agents/failover-error.js";
import { sleepWithAbort } from "../../src/infra/backoff.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";

vi.mock("../../src/infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infra/backoff.js")>()),
  sleepWithAbort: vi.fn(async () => {}),
}));

let providerOwner: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

beforeAll(async () => {
  const { default: openrouterPlugin } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({
    pluginId: "openrouter",
    artifactBasename: "index.js",
  });
  providerOwner = await registerSingleProviderPlugin(openrouterPlugin);
});

const model = {
  id: "example/model",
  name: "OpenRouter mock",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_024,
} satisfies Model<"openai-completions">;

async function runAgainstOpenRouterError(params: {
  message: string;
  context: Context;
  status?: number;
}): Promise<{
  reason: string | null;
  requestBody: string;
  requestCount: number;
  assistant: AssistantMessage;
}> {
  let requestBody = "";
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      const status = params.status ?? 404;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: status, message: params.message } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const result = await streamOpenAICompletions(
      { ...model, baseUrl: `http://127.0.0.1:${address.port}/api/v1` },
      params.context,
      { apiKey: ["test", "key"].join("-") },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(params.message);
    return {
      reason: classifyAssistantFailoverReason(result, { providerOwner }),
      requestBody,
      requestCount,
      assistant: result,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function runAgainstOpenRouterStream(event: Record<string, unknown>) {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    return await streamOpenAICompletions(
      { ...model, baseUrl: `http://127.0.0.1:${address.port}/api/v1` },
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: ["test", "key"].join("-") },
    ).result();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function makeOpenRouterStreamEvent(params: {
  finishReason: string;
  error?: { code: number; message: string; metadata: { error_type: string } };
}): Record<string, unknown> {
  return {
    id: "gen-test",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta: {}, finish_reason: params.finishReason }],
    ...(params.error ? { error: params.error } : {}),
  };
}

function expectFallbackBoundary(
  result: AssistantMessage,
  expected: { reason: "server_error" | "timeout"; status: number },
): void {
  const reason = classifyAssistantFailoverReason(result, { providerOwner });
  expect(reason).toBe(expected.reason);
  if (!reason) {
    throw new Error("expected streamed provider error to be classified");
  }
  expect(resolveFailoverStatus(reason)).toBe(expected.status);

  const errorMessage = result.errorMessage;
  if (!errorMessage) {
    throw new Error("expected streamed provider error message");
  }
  const fallback = resolveModelFallbackError(new Error(errorMessage), {
    provider: model.provider,
    model: model.id,
  });
  expect(fallback.kind).toBe("failover");
  if (fallback.kind === "failover") {
    expect(fallback.error).toMatchObject(expected);
  }
}

describe("OpenRouter runtime error classification", () => {
  it.each([
    "Prompt tokens limit exceeded: 24338 > 16443. To increase, visit https://example.invalid/organizations/synthetic/settings/keys and adjust the key's total limit",
    "This request requires more credits, or fewer max_tokens. You requested up to 2048 tokens, but can only afford 1954. To increase, visit https://example.invalid/organizations/synthetic/settings/keys and adjust the key's total limit",
  ])("does not retry an HTTP 402 key budget rejection: %s", async (message) => {
    const result = await runAgainstOpenRouterError({
      status: 402,
      message,
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    });
    expect(result.assistant).toMatchObject({
      provider: model.provider,
      model: model.id,
      errorCode: "402",
      errorMessage: `402 ${message}`,
    });
    expect(JSON.parse(result.assistant.errorBody!)).toMatchObject({ code: 402, message });
    expect(result.requestCount).toBe(1);
    vi.mocked(sleepWithAbort).mockClear();
    const fixture = await recoverAfterTransportDrop({
      assistant: result.assistant,
      providerOwner,
      noTools: true,
      replaySafe: true,
    });
    expect.soft(result.reason).toBe("billing");
    expect.soft(fixture.recovery).toEqual({ action: "proceed" });
    expect.soft(fixture.continueFromCurrentTranscript).not.toHaveBeenCalled();
    expect.soft(fixture.markOwnedTranscriptRetry).not.toHaveBeenCalled();
    expect.soft(fixture.onAgentEvent).not.toHaveBeenCalled();
    expect.soft(sleepWithAbort).not.toHaveBeenCalled();
    expect.soft(fixture.failoverRetryController.transientRetryCount).toBe(0);
  });

  it("keeps genuine HTTP 429 recovery at nine same-model retries", async () => {
    const result = await runAgainstOpenRouterError({
      status: 429,
      message: "Rate limit exceeded",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    });
    vi.mocked(sleepWithAbort).mockClear();
    const fixture = await recoverAfterTransportDrop({
      assistant: result.assistant,
      providerOwner,
      noTools: true,
      replaySafe: true,
    });
    expect(result.reason).toBe("rate_limit");
    expect(fixture.recovery).toMatchObject({
      action: "retry",
      lastRetryFailoverReason: "rate_limit",
    });
    for (let retry = 2; retry <= 9; retry++) {
      expect(await fixture.recover()).toMatchObject({
        action: "retry",
        lastRetryFailoverReason: "rate_limit",
      });
    }
    expect(await fixture.recover()).toEqual({ action: "proceed" });
    expect(fixture.continueFromCurrentTranscript).toHaveBeenCalledTimes(9);
    expect(fixture.markOwnedTranscriptRetry).toHaveBeenCalledTimes(9);
    expect(fixture.onAgentEvent).toHaveBeenCalledTimes(9);
    expect(sleepWithAbort).toHaveBeenCalledTimes(9);
    expect(fixture.failoverRetryController.transientRetryCount).toBe(9);
    expect(fixture.onAgentEvent).toHaveBeenLastCalledWith({
      stream: "run_status",
      data: expect.objectContaining({
        phase: "retrying",
        reason: "rate_limit",
        attempt: 10,
        maxAttempts: 10,
      }),
    });
  });

  it("keeps a bare streamed finish_reason error eligible for server failover", async () => {
    const result = await runAgainstOpenRouterStream(
      makeOpenRouterStreamEvent({ finishReason: "error" }),
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider finish_reason: error",
    });
    expectFallbackBoundary(result, { reason: "server_error", status: 500 });
    expect(formatAssistantErrorText(result)).toBe("Provider finish_reason: error");
  });

  it("keeps a streamed network_error in the timeout lane", async () => {
    const result = await runAgainstOpenRouterStream(
      makeOpenRouterStreamEvent({ finishReason: "network_error" }),
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider finish_reason: network_error",
    });
    expectFallbackBoundary(result, { reason: "timeout", status: 408 });
  });

  it("preserves a structured streamed rate-limit classification", async () => {
    const result = await runAgainstOpenRouterStream(
      makeOpenRouterStreamEvent({
        finishReason: "error",
        error: {
          code: 429,
          message: "Rate limit exceeded",
          metadata: { error_type: "rate_limit_exceeded" },
        },
      }),
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Rate limit exceeded");
    const reason = classifyAssistantFailoverReason(result, { providerOwner });
    expect(reason).toBe("rate_limit");
    if (!reason) {
      throw new Error("expected structured rate-limit error to be classified");
    }
    expect(resolveFailoverStatus(reason)).toBe(429);
  });

  it("treats an image-capability 404 as a terminal format failure", async () => {
    const result = await runAgainstOpenRouterError({
      message: "No endpoints found that support image input",
      context: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image", mimeType: "image/png", data: "aW1n" },
            ],
            timestamp: 1,
          },
        ],
      },
    });

    expect(result.reason).toBe("format");
    expect(JSON.parse(result.requestBody)).toMatchObject({
      messages: [
        {
          content: [{ type: "text", text: "describe this" }, { type: "image_url" }],
        },
      ],
    });
  });

  it("keeps a genuine missing-model 404 eligible for model fallback", async () => {
    const result = await runAgainstOpenRouterError({
      message: "No endpoints found for missing/model.",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    });

    expect(result.reason).toBe("model_not_found");
  });

  it("applies OpenRouter billing policy to an HTTP 403 key-limit error", async () => {
    const result = await runAgainstOpenRouterError({
      status: 403,
      message: "Key limit exceeded",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    });

    expect(result.reason).toBe("billing");
  });
});
