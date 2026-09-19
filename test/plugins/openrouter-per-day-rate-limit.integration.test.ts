import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildAssistantFailoverSignal,
  classifyAssistantFailoverReason,
} from "../../src/agents/embedded-agent-helpers/assistant-message-failures.js";
import { hasLongWindowRateLimitEvidence } from "../../src/agents/failover/retry-evidence.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";

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

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

describe("OpenRouter per-day cap reaches the real retry owner", () => {
  it("a real HTTP 429 carrying the reported free-models-per-day body is refused a same-model retry by the production long-window guard", async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: 429, message: "Rate limit exceeded: free-models-per-day-high-balance." },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    let reason: string | null;
    let retryMessage: string | undefined;
    try {
      const address = server.address() as AddressInfo;
      const result = await streamOpenAICompletions(
        { ...model, baseUrl: `http://127.0.0.1:${address.port}/api/v1` },
        context,
        { apiKey: ["test", "key"].join("-") },
      ).result();

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("free-models-per-day-high-balance");

      reason = classifyAssistantFailoverReason(result, { providerOwner });
      // attempt-recovery.ts:331 passes assistantSignal.message (built by
      // buildAssistantFailoverSignal, the RAW trimmed errorMessage) into
      // maybeRetryTransient as retry.message — not the user-facing friendly
      // copy from formatAssistantErrorText. Match that exact production
      // value so this test proves what the real retry guard actually sees.
      retryMessage = buildAssistantFailoverSignal(result).message;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    // Same reason the real embedded-agent-runner attempt loop passes as
    // retry.reason into failover-retry-controller.ts's maybeRetryTransient().
    expect(reason).toBe("rate_limit");

    // The exact guard failover-retry-controller.ts:232 calls with retry.message
    // before allowing a same-model transient retry. A message that came from a
    // real HTTP round-trip through the real transport must make this return
    // true, or the production controller burns retries against an exhausted
    // daily cap instead of failing over.
    expect(hasLongWindowRateLimitEvidence(retryMessage)).toBe(true);
  });
});
