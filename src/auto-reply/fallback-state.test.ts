/** Tests model fallback notice formatting and transition state tracking. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { canonicalizeProviderModelId } from "../agents/provider-model-route.js";
import {
  resolveActiveFallbackState,
  type FallbackNoticeState,
} from "../status/fallback-notice-state.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "./fallback-state.js";

const baseAttempt = {
  provider: "demo-primary",
  model: "demo-primary/model-a",
  error: "Provider demo-primary is in cooldown (all profiles unavailable)",
  reason: "rate_limit" as const,
};

function noticeState(
  selectedModel = "demo-primary/model-a",
  activeModel = "demo-fallback/model-b",
  reason = "rate limit",
): FallbackNoticeState {
  return { fallbackNotice: { kind: "active", selectedModel, activeModel, reason } };
}

const activeFallbackState = noticeState();
const cliBackend = {
  id: "claude-cli",
  modelProvider: "anthropic",
  config: { command: "claude" },
  bundleMcp: false,
};
const cliSelected = "anthropic/claude-opus-4-7";
const cliActive = "claude-cli/claude-opus-4-7";
const cliNoticeState = noticeState(cliSelected, cliActive, "selected model unavailable");

const setupCliBackend = ({ backend }: { backend: string }) =>
  backend === "claude-cli" ? { pluginId: "anthropic", backend: cliBackend } : undefined;

function resolveDemoFallbackTransition(
  overrides: Partial<Parameters<typeof resolveFallbackTransition>[0]> = {},
) {
  return resolveFallbackTransition({
    selectedProvider: "demo-primary",
    selectedModel: "model-a",
    activeProvider: "demo-fallback",
    activeModel: "model-b",
    attempts: [baseAttempt],
    state: {},
    ...overrides,
  });
}

const cliAliasTransition = {
  selectedProvider: "anthropic",
  selectedModel: "claude-opus-4-7",
  activeProvider: "claude-cli",
  activeModel: "claude-opus-4-7",
  attempts: [],
  state: cliNoticeState,
  cfg: {},
} satisfies Parameters<typeof resolveFallbackTransition>[0];

describe("fallback-state", () => {
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it.each<[string, FallbackNoticeState | undefined, boolean, number, string?, string?]>([
    ["matching persisted refs", activeFallbackState, true, 2],
    ["absent persisted state", undefined, false, 0],
    ["different selected ref", noticeState("other-provider/other-model"), false, 0],
    ["different active ref", noticeState(undefined, "other-provider/other-model"), false, 0],
    ["matching CLI runtime alias", cliNoticeState, false, 2, cliSelected, cliActive],
  ])(
    "resolves %s without unnecessary alias discovery",
    (_name, state, active, expectedSetupLookups, selectedModelRef, activeModelRef) => {
      const lookup = vi.fn(setupCliBackend);
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [],
        resolvePluginSetupCliBackend: lookup,
      });
      const resolved = resolveActiveFallbackState({
        selectedModelRef: selectedModelRef ?? "demo-primary/model-a",
        activeModelRef: activeModelRef ?? "demo-fallback/model-b",
        config: {},
        state,
      });

      expect(resolved).toEqual({ active, reason: active ? "rate limit" : undefined });
      expect(lookup).toHaveBeenCalledTimes(expectedSetupLookups);
    },
  );

  it("preserves provider-local model prefixes through fallback and recovery", () => {
    const refs = {
      selectedProvider: "custom",
      selectedModel: "custom/model",
      activeProvider: "custom",
      activeModel: "model",
      attempts: [{ ...baseAttempt, provider: "custom", model: "custom/model" }],
    };
    const activated = resolveDemoFallbackTransition(refs);
    expect(activated).toMatchObject({
      fallbackActive: true,
      fallbackTransitioned: true,
      nextState: { selectedModel: "custom/custom/model", activeModel: "custom/model" },
      attemptSummaries: ["custom/custom/model rate limit"],
    });
    const state = noticeState(
      activated.selectedModelRef,
      activated.activeModelRef,
      activated.reasonSummary,
    );
    expect(resolveDemoFallbackTransition({ ...refs, state })).toMatchObject({
      fallbackTransitioned: false,
      stateChanged: false,
    });
    expect(
      resolveDemoFallbackTransition({ ...refs, activeModel: refs.selectedModel, state }),
    ).toMatchObject({
      fallbackCleared: true,
      nextState: { selectedModel: undefined, activeModel: undefined, reason: undefined },
    });
    expect(buildFallbackNotice(refs)).toContain("selected custom/custom/model");
    expect(
      buildFallbackClearedNotice({ ...refs, previousActiveModel: activated.activeModelRef }),
    ).toBe("↪️ Model Fallback cleared: custom/custom/model (was custom/model)");
  });

  it.each([
    {
      name: "formatted HTTP details",
      error: "429 Too Many Requests: Claude Max usage limit reached, try again in 6 minutes.",
      contains: ["HTTP 429: Too Many Requests", "Claude Max usage limit reached"],
    },
    {
      name: "throttle details",
      error: "ThrottlingException: Too many concurrent requests",
      contains: ["ThrottlingException"],
      not: "rate limit",
    },
    { name: "non-transient reason", error: "Unauthorized: invalid API key", exact: "rate limit" },
    {
      name: "UTF-16-safe truncation",
      error: `429 ${"x".repeat(68)}😀tail`,
      exact: `HTTP 429: ${"x".repeat(68)}…`,
    },
  ])("formats $name", ({ error, contains, exact, not }) => {
    const { reasonSummary } = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, error }],
    });
    for (const part of contains ?? []) {
      expect(reasonSummary).toContain(part);
    }
    if (exact !== undefined) {
      expect(reasonSummary).toBe(exact);
    }
    if (not !== undefined) {
      expect(reasonSummary).not.toBe(not);
    }
  });

  it("refreshes reason when fallback remains active with same model pair", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, reason: "timeout" }],
      state: activeFallbackState,
    });

    expect(resolved).toMatchObject({
      fallbackTransitioned: false,
      stateChanged: true,
      nextState: { reason: "timeout" },
    });
  });

  it("does not treat a CLI runtime alias as a model fallback", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [{ ...cliBackend, pluginId: "anthropic" }],
    });

    const resolved = resolveFallbackTransition(cliAliasTransition);

    expect(resolved).toMatchObject({
      fallbackActive: false,
      fallbackCleared: false,
      stateChanged: true,
      nextState: { selectedModel: undefined, activeModel: undefined },
    });
  });

  it("does not repeat runtime alias comparison when persisted fallback refs match", () => {
    const lookup = vi.fn(setupCliBackend);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: lookup,
      resolvePluginSetupRegistry: () => {
        throw new Error("full setup registry should not load for a single runtime alias");
      },
      resolveRuntimeCliBackends: () => [],
    });

    const resolved = resolveFallbackTransition(cliAliasTransition);

    expect(resolved.fallbackActive).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  describe("Arcee wire identity", () => {
    const selectedModelRef = "arcee/trinity-large-preview";
    const aliasRef = "arcee/arcee-ai/trinity-large-preview";
    const base = {
      selectedProvider: "arcee",
      selectedModel: "trinity-large-preview",
      activeProvider: "arcee",
      activeModel: "arcee-ai/trinity-large-preview",
      attempts: [],
      cfg: {},
      state: {},
    };
    it.each<[string, FallbackNoticeState, boolean]>([
      ["fresh state", {}, false],
      [
        "captured alias-only state",
        noticeState(selectedModelRef, aliasRef, "selected model unavailable"),
        true,
      ],
    ])("keeps %s out of fallback state", (_name, state, expectedStateChanged) => {
      const params = { ...base, state };

      expect(canonicalizeProviderModelId("arcee", "arcee-ai/trinity-large-preview")).toBe(
        "trinity-large-preview",
      );

      const resolved = resolveFallbackTransition(params);

      expect(resolved).toMatchObject({
        fallbackActive: false,
        fallbackTransitioned: false,
        fallbackCleared: false,
        stateChanged: expectedStateChanged,
      });
      expect(resolved.nextState).toEqual({
        selectedModel: undefined,
        activeModel: undefined,
        reason: undefined,
      });
      expect(buildFallbackNotice(params)).toBeNull();
      expect(
        resolveActiveFallbackState({
          selectedModelRef,
          activeModelRef: aliasRef,
          config: {},
          state,
        }),
      ).toEqual({ active: false, reason: undefined });
    });

    it.each([
      {
        name: "different model",
        activeProvider: "arcee",
        activeModel: "arcee-ai/trinity-large-thinking",
        activeRef: "arcee/arcee-ai/trinity-large-thinking",
      },
      {
        name: "different provider",
        activeProvider: "openrouter",
        activeModel: "arcee-ai/trinity-large-preview",
        activeRef: "openrouter/arcee-ai/trinity-large-preview",
      },
    ])("keeps a $name as a real fallback", ({ activeProvider, activeModel, activeRef }) => {
      const params = { ...base, activeProvider, activeModel };

      const resolved = resolveFallbackTransition(params);

      expect(resolved).toMatchObject({
        fallbackActive: true,
        fallbackTransitioned: true,
        fallbackCleared: false,
        stateChanged: true,
        nextState: {
          selectedModel: selectedModelRef,
          activeModel: activeRef,
        },
      });
      expect(buildFallbackNotice(params)).toContain(activeRef);
      expect(
        resolveActiveFallbackState({
          selectedModelRef,
          activeModelRef: activeRef,
          config: {},
          state: noticeState(selectedModelRef, activeRef, "selected model unavailable"),
        }),
      ).toEqual({ active: true, reason: "selected model unavailable" });
    });
  });
});
