import assert from "node:assert/strict";
import type { DecisionBatch, DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../extensions/subq/index.js";
import { validateDecisionBatch, validateDecisionResult } from "../src/decisions/validation.js";

// mock-isolation: Exercise the registered adapter with a host-prepared synthetic credential.
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));

const cases = [
  {
    question: { type: "boolean" },
    answer: { type: "noul", noul: 0.9 },
  },
  {
    question: { type: "choice", criteria: { support: "Service failures", sales: null } },
    answer: { type: "choice", choice: "support", probabilities: { support: 0.8, sales: 0.2 } },
  },
  {
    question: { type: "score", criteria: ["Low", "High"] },
    answer: {
      type: "score",
      score: 0.6,
      probabilities: { "0": 0.4, "1": 0.6 },
      legend: { "0": "Low", "1": "High" },
    },
  },
] satisfies { question: DecisionBatch["questions"][string]; answer: unknown }[];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(
  cases.flatMap(({ question, answer }) =>
    ["__proto__", "constructor", "prototype"].map((id) => ({ id, question, answer })),
  ),
)(
  "round-trips the admitted $question.type question key $id through host validation",
  async ({ id, question, answer }) => {
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({
      revision: 1,
      value: "synthetic-subq-key",
    });
    const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
    plugin.register({ registerDecisionProvider } as unknown as OpenClawPluginApi);
    const provider = registerDecisionProvider.mock.calls[0]?.[0];
    assert(provider?.contractVersion === 1);
    const batch: DecisionBatch = {
      state: "Service is down",
      questions: Object.fromEntries([[id, question]]),
    };
    expect(validateDecisionBatch(batch)).toBe(true);
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        model: "subq-snap-preview",
        answers: Object.fromEntries([[id, answer]]),
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const context: Parameters<DecisionProviderV1["evaluate"]>[1] = {
      model: "subq-snap-preview",
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 30_000,
    };
    const outcome = await provider.evaluate(batch, context);
    assert(outcome.status === "ok");
    expect(validateDecisionResult(batch, outcome.result)).toBe(true);
    expect(Object.hasOwn(outcome.result.answers, id)).toBe(true);
    // JSON serialization must preserve reserved own keys in the returned result.
    const serialized = JSON.stringify(outcome.result);
    expect(validateDecisionResult(batch, JSON.parse(serialized))).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const body = fetch.mock.calls[0]?.[1]?.body;
    assert(typeof body === "string");
    expect(Object.keys(JSON.parse(body).questions)).toEqual([id]);
  },
);
