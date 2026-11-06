import { expect, it, vi } from "vitest";
import { executeOpenAIDecision, type OpenAIDecisionExecution } from "./decisions-openai-runtime.js";
import type { DecisionBatchV2 } from "./decisions/types-v2.js";

const guard = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("./provider-http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-http.js")>()),
  fetchWithProviderHttpGuard: guard.fetch,
}));

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "explicit fixture" },
  questions: { truth: { type: "boolean" } },
};

function execution(): OpenAIDecisionExecution {
  return {
    provider: "fixture",
    modelId: "fixture",
    baseUrl: "https://example.com",
    auth: { mode: "api-key", apiKey: "synthetic-key" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 5_000,
    isAdmissible: () => true,
  };
}

it.each(["pending", "rejected"])(
  "keeps failure classification when decision error-body cancellation is %s",
  async (settlement) => {
    const cancel = vi.fn(() =>
      settlement === "pending"
        ? new Promise<void>(() => {})
        : Promise.reject(new Error("synthetic cancellation failure")),
    );
    const response = new Response(new ReadableStream({ cancel }), {
      status: 429,
      headers: { "retry-after": "60" },
    });
    guard.fetch.mockResolvedValueOnce({
      response,
      finalUrl: "https://example.com/decisions",
      release: async () => {},
    });
    await expect(executeOpenAIDecision(batch, execution())).resolves.toEqual({
      status: "unavailable",
      reason: "rate-limited",
      retryAfterMs: 60_000,
    });
    expect(cancel).toHaveBeenCalledOnce();
  },
);
