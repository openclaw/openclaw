import { createServer } from "node:http";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyAssistantFailoverReason } from "../../src/agents/embedded-agent-helpers/assistant-message-failures.js";
import { formatUserFacingAssistantErrorText } from "../../src/agents/embedded-agent-helpers/error-text.js";
import { resolveAuthProfileFailureReason } from "../../src/agents/embedded-agent-runner/run/auth-profile-failure-policy.js";
import { classifyFailoverSignal } from "../../src/agents/failover/classify.js";
import { runWithModelFallback } from "../../src/agents/model-fallback-runner.js";
import { makeProviderModelFixture } from "../../src/agents/test-helpers/provider-model-fixture.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
  respondJson,
} from "../helpers/gateway-integration-fixtures.js";
import { loadBundledProviderPlugin } from "../helpers/media-generation/bundled-provider-builders.js";

const outage = "Upstream request failed: Endpoint is unavailable.";
let providerOwner: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

beforeAll(async () => {
  providerOwner = await registerSingleProviderPlugin(
    await loadBundledProviderPlugin("opencode-go"),
  );
});

describe("OpenCode Go endpoint failures", () => {
  it("keeps an unavailable model from cooling the shared key or blocking a healthy sibling", async () => {
    const requestedModels: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const body = JSON.parse(await readRequestText(request)) as { model: string };
        requestedModels.push(body.model);
        if (body.model === "gemini-4-argon") {
          respondJson(response, { error: { code: 403, status: "UNKNOWN", message: outage } }, 403);
        } else {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            'data: {"choices":[{"index":0,"delta":{"content":"healthy"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        }
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    const baseUrl = `${await listenLoopback(server)}/v1`;
    const run = (id: string) =>
      streamOpenAICompletions(
        makeProviderModelFixture<"openai-completions">({
          id,
          name: id,
          api: "openai-completions",
          provider: "opencode-go",
          baseUrl,
        }),
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        { apiKey: "synthetic-key" },
      ).result();
    try {
      let failed: Awaited<ReturnType<typeof run>> | undefined;
      const fallback = await runWithModelFallback({
        cfg: undefined,
        provider: "opencode-go",
        model: "gemini-4-argon",
        fallbacksOverride: ["opencode-go/deepseek-v4.1-flash"],
        skipAuthProfileRuntime: true,
        run: async (_provider, model) => {
          const result = await run(model);
          if (model === "gemini-4-argon") {
            failed = result;
          }
          return result;
        },
        classifyResult: ({ result }) =>
          result.stopReason === "error"
            ? {
                message: result.errorMessage ?? "",
                reason: classifyAssistantFailoverReason(result, { providerOwner }) ?? "unknown",
              }
            : null,
      });
      expect(failed?.stopReason).toBe("error");
      expect(failed?.errorMessage).toContain(outage);
      if (!failed) {
        throw new Error("expected the unavailable model to run first");
      }
      const reason = classifyAssistantFailoverReason(failed, { providerOwner });
      expect(reason).toBe("server_error");
      expect(
        resolveAuthProfileFailureReason({ failoverReason: reason, providerStarted: true }),
      ).toBeNull();
      expect(formatUserFacingAssistantErrorText(failed, { providerOwner })).toBe(
        "⚠️ The AI service is having trouble. Please try again in a moment.",
      );

      expect(fallback).toMatchObject({ outcome: "completed", model: "deepseek-v4.1-flash" });
      expect(fallback.result.stopReason).toBe("stop");
      expect(requestedModels).toEqual(["gemini-4-argon", "deepseek-v4.1-flash"]);
    } finally {
      await closeHttpServer(server);
    }
  });

  it.each(["Invalid API key", "You do not have permission to use this model"])(
    "preserves auth classification for a genuine 403: %s",
    (message) => {
      expect(
        classifyFailoverSignal(
          { provider: "opencode-go", status: 403, message },
          { providerPlugin: providerOwner },
        ),
      ).toEqual({ kind: "reason", reason: "auth" });
    },
  );
});
