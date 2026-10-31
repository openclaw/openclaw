import { afterEach, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import {
  resolveActiveFallbackState,
  type FallbackNoticeState,
} from "../status/fallback-notice-state.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "./fallback-state.js";

const attempt = {
  provider: "primary",
  model: "a",
  error: "cooldown",
  reason: "rate_limit" as const,
};
function notice(
  selectedModel = "primary/a",
  activeModel = "fallback/b",
  reason = "rate limit",
): FallbackNoticeState {
  return { fallbackNotice: { kind: "active", selectedModel, activeModel, reason } };
}
const cleared = { selectedModel: undefined, activeModel: undefined, reason: undefined };
function pair(
  selectedProvider: string,
  selectedModel: string,
  activeProvider = selectedProvider,
  activeModel = selectedModel,
) {
  return { selectedProvider, selectedModel, activeProvider, activeModel };
}
function activeState(
  selectedModelRef: string,
  activeModelRef: string,
  state?: FallbackNoticeState,
) {
  return resolveActiveFallbackState({ selectedModelRef, activeModelRef, state, config: {} });
}
function transition(overrides: Partial<Parameters<typeof resolveFallbackTransition>[0]> = {}) {
  return resolveFallbackTransition({
    ...pair("primary", "a", "fallback", "b"),
    attempts: [attempt],
    ...overrides,
  });
}
afterEach(() => cliBackendsTesting.resetDepsForTest());

it.each([
  [notice(), true],
  [undefined, false],
  [notice("other/model"), false],
  [notice(undefined, "other/model"), false],
] as const)("uses only matching persisted fallback state: %j", (state, active) => {
  expect(activeState("primary/a", "fallback/b", state)).toEqual({
    active,
    reason: active ? "rate limit" : undefined,
  });
});

it("preserves provider-local prefixes through activation, repetition and recovery", () => {
  const refs = {
    ...pair("custom", "custom/model", "custom", "model"),
    attempts: [{ ...attempt, provider: "custom", model: "custom/model" }],
  };
  const active = transition(refs);
  expect(active).toMatchObject({
    fallbackActive: true,
    fallbackTransitioned: true,
    nextState: { selectedModel: "custom/custom/model", activeModel: "custom/model" },
  });
  const state = notice(active.selectedModelRef, active.activeModelRef, active.reasonSummary);
  expect(transition({ ...refs, state })).toMatchObject({
    fallbackTransitioned: false,
    stateChanged: false,
  });
  expect(transition({ ...refs, activeModel: refs.selectedModel, state })).toMatchObject({
    fallbackCleared: true,
    nextState: cleared,
  });
  expect(buildFallbackNotice(refs)).toContain("selected custom/custom/model");
  expect(buildFallbackClearedNotice({ ...refs, previousActiveModel: active.activeModelRef })).toBe(
    "↪️ Model Fallback cleared: custom/custom/model (was custom/model)",
  );
});

it.each([
  [
    "429 Too Many Requests: Claude Max usage limit reached, try again in 6 minutes.",
    [
      expect.stringContaining("HTTP 429: Too Many Requests"),
      expect.stringContaining("Claude Max usage limit reached"),
    ],
  ],
  [
    "ThrottlingException: Too many concurrent requests",
    [expect.stringContaining("ThrottlingException"), expect.not.stringMatching(/^rate limit$/)],
  ],
  ["Unauthorized: invalid API key", ["rate limit"]],
  [`429 ${"x".repeat(68)}😀tail`, [`HTTP 429: ${"x".repeat(68)}…`]],
] as const)("formats transient details without exposing auth errors: %s", (error, expected) => {
  const { reasonSummary } = transition({ attempts: [{ ...attempt, error }] });
  for (const value of expected) {
    expect(reasonSummary).toEqual(value);
  }
});

it("refreshes a changed reason without reactivating the fallback", () => {
  expect(
    transition({ attempts: [{ ...attempt, reason: "timeout" }], state: notice() }),
  ).toMatchObject({
    fallbackTransitioned: false,
    stateChanged: true,
    nextState: { reason: "timeout" },
  });
});

it.each([false, true])("recognizes CLI aliases with setup discovery=%s", (setup) => {
  const backend = {
    id: "claude-cli",
    modelProvider: "anthropic",
    config: { command: "claude" },
    bundleMcp: false,
  };
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => (setup ? [] : [{ ...backend, pluginId: "anthropic" }]),
    resolvePluginSetupCliBackend: ({ backend: id }) =>
      id === backend.id ? { pluginId: "anthropic", backend } : undefined,
  });
  const state = notice("anthropic/claude-opus-4-7", "claude-cli/claude-opus-4-7");
  expect(
    transition({
      ...pair("anthropic", "claude-opus-4-7", "claude-cli"),
      attempts: [],
      cfg: {},
      state,
    }),
  ).toMatchObject({
    fallbackActive: false,
    fallbackCleared: false,
    stateChanged: true,
    nextState: cleared,
  });
  expect(activeState("anthropic/claude-opus-4-7", "claude-cli/claude-opus-4-7", state)).toEqual({
    active: false,
    reason: undefined,
  });
});

const selected = "arcee/trinity-large-preview";
const alias = "arcee/arcee-ai/trinity-large-preview";
const arcee = {
  ...pair("arcee", "trinity-large-preview", "arcee", "arcee-ai/trinity-large-preview"),
  attempts: [],
  cfg: {},
};
it.each([{}, notice(selected, alias, "selected model unavailable")])(
  "does not persist an Arcee wire alias as fallback: %j",
  (state) => {
    const params = { ...arcee, state };
    expect(transition(params)).toMatchObject({
      fallbackActive: false,
      fallbackTransitioned: false,
      fallbackCleared: false,
      stateChanged: "fallbackNotice" in state,
      nextState: cleared,
    });
    expect(buildFallbackNotice(params)).toBeNull();
  },
);
it.each([
  ["arcee", "arcee-ai/trinity-large-thinking"],
  ["openrouter", "arcee-ai/trinity-large-preview"],
])("retains a genuine provider/model change: %s/%s", (activeProvider, activeModel) => {
  const params = { ...arcee, activeProvider, activeModel };
  const activeModelRef = `${activeProvider}/${activeModel}`;
  expect(transition(params)).toMatchObject({
    fallbackActive: true,
    nextState: { selectedModel: selected, activeModel: activeModelRef },
  });
});

const hops = [
  attempt,
  { provider: "second", model: "b", error: "upstream", reason: "timeout" as const },
  { provider: "third", model: "c", error: "busy", reason: "overloaded" as const },
];
const chain = { ...pair("primary", "a", "fourth", "d"), attempts: hops };

it("names every failed hop with its model and reason", () => {
  const { reasonSummary, attemptSummaries } = transition(chain);
  expect(reasonSummary).toBe("primary/a rate limit; second/b timeout; third/c overloaded");
  expect(reasonSummary).toBe(attemptSummaries.join("; "));
  expect(buildFallbackNotice(chain)).toBe(
    "↪️ Model Fallback: fourth/d (selected primary/a; primary/a rate limit; second/b timeout; third/c overloaded)",
  );
});

it("shows at most three hops and counts the rest", () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ ...attempt, provider: `p${i}`, model: "m" }));
  expect(transition({ attempts: six }).reasonSummary).toBe(
    "p0/m rate limit; p1/m rate limit; p2/m rate limit (+3 more attempts)",
  );
});

it("keeps the single-attempt notice unchanged", () => {
  const params = { ...pair("primary", "a", "fallback", "b"), attempts: [attempt] };
  expect(buildFallbackNotice(params)).toBe(
    "↪️ Model Fallback: fallback/b (selected primary/a; rate limit)",
  );
});

it("keeps each hop's reason when the model ref is long", () => {
  const model =
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile";
  const timeout = { provider: "second", model: "b", error: "upstream", reason: "timeout" as const };
  expect(
    transition({ attempts: [{ ...attempt, provider: "amazon-bedrock", model }, timeout] })
      .reasonSummary,
  ).toBe("amazon-bedrock/arn:…le/my-claude-profile rate limit; second/b timeout");
});

it("truncates each hop's long reason separately", () => {
  const verbose = { ...attempt, error: `429 ${"x".repeat(100)}` };
  const parts = transition({ attempts: [verbose, verbose] }).reasonSummary.split("; ");
  expect(parts).toHaveLength(2);
  for (const part of parts) {
    expect(part).toMatch(/^primary\/a HTTP 429: x+…$/);
    expect(part).toHaveLength(80);
  }
});

it("does not repeat a notice for the same failed chain", () => {
  const first = transition(chain);
  const state = notice(first.selectedModelRef, first.activeModelRef, first.reasonSummary);
  expect(transition({ ...chain, state })).toMatchObject({
    fallbackTransitioned: false,
    stateChanged: false,
  });
});
