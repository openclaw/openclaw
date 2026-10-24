import { createServer } from "node:http";
import type { AssistantMessage, Context } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { classifyAssistantFailoverReason } from "../../src/agents/embedded-agent-helpers/assistant-message-failures.js";
import { formatAssistantErrorText } from "../../src/agents/embedded-agent-helpers/error-text.js";
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
  readRequestText,
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
  name: "OpenRouter mock",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "",
  input: ["text", "image"],
  maxTokens: 1_024,
});

async function runAgainstOpenRouter(params: {
  message?: string;
  context?: Context;
  status?: number;
  event?: { choices: { index: number; delta: object; finish_reason: string }[]; error?: object };
}) {
  let requestBody = "";
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    void (async () => {
      requestBody += await readRequestText(request);
      if (params.event) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify(params.event)}\n\ndata: [DONE]\n\n`);
      } else {
        const status = params.status ?? 404;
        respondJson(response, { error: { code: status, message: params.message } }, status);
      }
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  const baseUrl = `${await listenLoopback(server)}/api/v1`;
  try {
    const assistant = await streamOpenAICompletions(
      { ...model, baseUrl },
      params.context ?? { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "test-key" },
    ).result();
    expect(assistant.stopReason).toBe("error");
    if (params.message) {
      expect(assistant.errorMessage).toContain(params.message);
    }
    return {
      assistant,
      requestBody,
      requestCount,
      reason: classifyAssistantFailoverReason(assistant, { providerOwner }),
    };
  } finally {
    await closeHttpServer(server);
  }
}

function expectFallbackBoundary(
  result: AssistantMessage,
  expected: { reason: "server_error" | "timeout" | "rate_limit"; status: number },
): void {
  const reason = classifyAssistantFailoverReason(result, { providerOwner });
  expect(reason).toBe(expected.reason);
  if (!reason) {
    throw new Error("expected streamed provider error to be classified");
  }
  expect(resolveFailoverStatus(reason)).toBe(expected.status);
  if (reason === "rate_limit") {
    return;
  }

  expect(
    resolveModelFallbackError(new Error(result.errorMessage), {
      provider: model.provider,
      model: model.id,
    }),
  ).toMatchObject({ kind: "failover", error: expected });
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

describe("OpenRouter runtime error classification", () => {
  it.each([
    "Prompt tokens limit exceeded: 24338 > 16443. To increase, visit https://example.invalid/organizations/synthetic/settings/keys and adjust the key's total limit",
    "This request requires more credits, or fewer max_tokens. You requested up to 2048 tokens, but can only afford 1954. To increase, visit https://example.invalid/organizations/synthetic/settings/keys and adjust the key's total limit",
  ])("does not retry an HTTP 402 key budget rejection: %s", async (message) => {
    const result = await runAgainstOpenRouter({ status: 402, message });
    expect(result.assistant).toMatchObject({
      provider: model.provider,
      model: model.id,
      errorCode: "402",
      errorMessage: `402 ${message}`,
    });
    expect(JSON.parse(result.assistant.errorBody!)).toMatchObject({ code: 402, message });
    expect(result.requestCount).toBe(1);
    const fixture = await recover(result.assistant);
    expect.soft(result.reason).toBe("billing");
    expect.soft(fixture.recovery).toEqual({ action: "proceed" });
    expectRetryEffects(fixture, 0);
  });

  it("keeps genuine HTTP 429 recovery at nine same-model retries", async () => {
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
    for (let retry = 2; retry <= 9; retry++) {
      expect(await fixture.recover()).toMatchObject(retryState);
    }
    expect(await fixture.recover()).toEqual({ action: "proceed" });
    expectRetryEffects(fixture, 9);
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
    const { assistant: result } = await runAgainstOpenRouter({
      event: {
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(error ? { error } : {}),
      },
    });
    const errorMessage = `Provider finish_reason: ${finishReason}`;
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: error ? expect.stringContaining(error.message) : errorMessage,
    });
    expectFallbackBoundary(result, { reason, status });
    if (finishReason === "error" && !error) {
      expect(formatAssistantErrorText(result)).toBe(errorMessage);
    }
  });

  it("treats an image-capability 404 as a terminal format failure", async () => {
    const result = await runAgainstOpenRouter({
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

  it.each([
    [404, "No endpoints found for missing/model.", "model_not_found"],
    [403, "Key limit exceeded", "billing"],
  ] as const)("classifies HTTP %s %s as %s", async (status, message, reason) => {
    const result = await runAgainstOpenRouter({ status, message });
    expect(result.reason).toBe(reason);
  });
});
