import { expect, expectTypeOf, it, vi } from "vitest";
import {
  DecisionContractError,
  decisionBatchV1ToV2,
  decisionBatchV2ToV1,
  isDecisionBatchV1Representable,
  decisionResultV2ToV1,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatch,
  type DecisionBatchV2,
} from "./decisions.js";

// mock-isolation: Decision execution must load without initializing the host harness.
vi.mock("./agent-harness-runtime.js", () => {
  throw new Error("Decision transport must not initialize the host harness");
});
// mock-isolation: Decision execution must load without initializing extension helpers.
vi.mock("./extension-shared.js", () => {
  throw new Error("Decision transport must not initialize extension helpers");
});

const nonOkFixture = vi.hoisted(() => ({
  cancel: (() => Promise.resolve(undefined)) as () => Promise<unknown>,
  releases: 0,
}));

// mock-isolation: Drive the OpenAI decision transport with a fixture response so the
// non-ok discard path can exercise cancellation that never settles or rejects.
vi.mock("./provider-http.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./provider-http.js")>();
  return {
    ...original,
    fetchWithProviderHttpGuard: (async () => ({
      response: {
        ok: false,
        status: 401,
        headers: new Headers(),
        bodyUsed: false,
        body: { cancel: () => nonOkFixture.cancel() },
      } as unknown as Response,
      release: async () => {
        nonOkFixture.releases += 1;
      },
    })) as unknown as (typeof original)["fetchWithProviderHttpGuard"],
  };
});

const nonOkBatch: DecisionBatchV2 = {
  state: { type: "text", text: "explicit fixture" },
  questions: { truth: { type: "boolean" } },
};

async function runNonOkDecision(deadlineMonotonicMs: number) {
  const { executeOpenAIDecision } = await import("./decisions-openai-runtime.js");
  return executeOpenAIDecision(nonOkBatch, {
    provider: "fixture",
    modelId: "fixture",
    baseUrl: "https://example.com",
    auth: { mode: "api-key", apiKey: "sk-fixture" },
    signal: new AbortController().signal,
    deadlineMonotonicMs,
    isAdmissible: () => true,
  });
}

it("handles Decision admission without initializing host runtime bundles", async () => {
  const { executeOpenAIDecision } = await import("./decisions-openai-runtime.js");
  await expect(
    executeOpenAIDecision(
      {
        state: { type: "text", text: "explicit fixture" },
        questions: { truth: { type: "boolean" } },
      },
      {
        provider: "fixture",
        modelId: "fixture",
        baseUrl: "https://example.com",
        auth: { mode: "api-key", apiKey: undefined },
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 1_000,
        isAdmissible: () => true,
      },
    ),
  ).resolves.toEqual({ status: "unavailable", reason: "credentials-unavailable" });
});

it("classifies a non-ok decision response without waiting out body cancellation", async () => {
  nonOkFixture.cancel = () => new Promise<undefined>(() => {});
  nonOkFixture.releases = 0;
  const outcome = runNonOkDecision(performance.now() + 150).then((value) => ({
    kind: "settled" as const,
    value,
  }));
  const hung = new Promise<{ kind: "hung" }>((resolve) => {
    setTimeout(() => resolve({ kind: "hung" }), 2_000);
  });
  await expect(Promise.race([outcome, hung])).resolves.toEqual({
    kind: "settled",
    value: { status: "unavailable", reason: "authentication" },
  });
  expect(nonOkFixture.releases).toBe(1);
});

it("classifies a non-ok decision response when body cancellation rejects", async () => {
  nonOkFixture.cancel = () => Promise.reject(new Error("cancel failed"));
  nonOkFixture.releases = 0;
  await expect(runNonOkDecision(performance.now() + 1_000)).resolves.toEqual({
    status: "unavailable",
    reason: "authentication",
  });
  expect(nonOkFixture.releases).toBe(1);
});

it("exposes lossless codecs and bounded validation through the public decision entrypoint", () => {
  const legacy: DecisionBatch = {
    state: "explicit fixture",
    questions: { truth: { type: "boolean" } },
  };
  const richer = decisionBatchV1ToV2(legacy);
  expect(richer).toEqual({
    state: { type: "text", text: "explicit fixture" },
    questions: legacy.questions,
  });
  if (!richer) {
    throw new Error("Representable fixture was rejected");
  }
  expect(validateDecisionBatchV2(richer)).toBe(true);
  if (!isDecisionBatchV1Representable(richer)) {
    throw new Error("Representable public fixture was rejected");
  }
  expectTypeOf(richer.questions).toMatchTypeOf<DecisionBatch["questions"]>();
  if (richer.state.type === "json") {
    expectTypeOf(richer.state.value).toMatchTypeOf<DecisionBatch["state"]>();
  }
  expect(decisionBatchV2ToV1(richer)).toEqual(legacy);
  const result = {
    model: "fixture",
    answers: { truth: { type: "boolean" as const, answer: false, probabilityTrue: 0.95 } },
  };
  expect(validateDecisionResultV2(richer, result)).toBe(true);
  expect(decisionResultV2ToV1(richer, result)).toBeUndefined();
  const explicitJson: DecisionBatchV2 = {
    ...richer,
    state: { type: "json", value: "explicit fixture" },
  };
  expect(isDecisionBatchV1Representable(explicitJson)).toBe(false);
  expect(decisionBatchV2ToV1(explicitJson)).toBeUndefined();
  expect(() => validateDecisionBatchV2({ state: null, questions: {} })).toThrow(
    DecisionContractError,
  );
});
