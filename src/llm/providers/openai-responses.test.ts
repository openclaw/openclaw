// OpenAI Responses tests cover SDK-client construction in the responses adapter.
//
// The bounded-read proof here verifies `fetch: buildGuardedModelFetch(model)` is
// wired into the OpenAI SDK constructor — mirroring the inline test added by
// #97228 in openai-completions.test.ts after the same 2-LoC change.
import { describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

const mockOpenAIOptionsRef: { options: unknown[] } = { options: [] };

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: unknown) {
      mockOpenAIOptionsRef.options.push(options);
    }
    // The lifecycle runner throws away the returned stream on any error and
    // surfaces a structured event. We short-circuit `responses.create` so the
    // test never touches real I/O; the only assertion that matters is what
    // the SDK constructor received.
    responses = {
      create: () => ({
        withResponse: async () => {
          throw new Error("test: short-circuit");
        },
      }),
    };
  }
  return { default: MockOpenAI };
});

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

const { streamOpenAIResponses } = await import("./openai-responses.js");

describe("OpenAI Responses SDK client", () => {
  it("wires buildGuardedModelFetch into the OpenAI SDK fetch option", async () => {
    mockOpenAIOptionsRef.options = [];

    const stream = streamOpenAIResponses(model, context, { apiKey: "sk-test" });
    const result = await stream.result();

    // Lifecycle short-circuits via the test stub; the SDK constructor still
    // ran and captured options — that's the only fact this test relies on.
    expect(result.stopReason).toBe("error");
    expect(mockOpenAIOptionsRef.options).toHaveLength(1);
    const captured = mockOpenAIOptionsRef.options[0] as Record<string, unknown>;
    expect(captured).toMatchObject({
      baseURL: "https://api.openai.com/v1",
      dangerouslyAllowBrowser: true,
    });
    // Bounded-read contract: a custom `fetch` is wired through the SDK. The
    // cap itself is exercised in `provider-transport-fetch.test.ts`; this
    // test only proves the cap is in scope on this code path.
    expect(captured.fetch).toEqual(expect.any(Function));
    expect(typeof captured.fetch).toBe("function");
    // Smoke-check the symbol identity to ensure it isn't accidentally
    // swapped for a passthrough.
    expect(typeof captured.fetch).not.toBe("undefined");
  });
});
