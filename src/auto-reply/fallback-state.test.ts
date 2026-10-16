/** Tests model fallback notice formatting and transition state tracking. */
import { afterEach, describe, expect, it } from "vitest";
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
const cliNoticeState = noticeState(
  "anthropic/claude-opus-4-7",
  "claude-cli/claude-opus-4-7",
  "selected model unavailable",
);

function registerAnthropicCliBackendForTest(): void {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [{ ...cliBackend, pluginId: "anthropic" }],
  });
}

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
    [
      "matching CLI runtime alias",
      cliNoticeState,
      false,
      2,
      "anthropic/claude-opus-4-7",
      "claude-cli/claude-opus-4-7",
    ],
  ])(
    "resolves %s without unnecessary alias discovery",
    (_name, state, active, expectedSetupLookups, selectedModelRef, activeModelRef) => {
      let setupLookups = 0;
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [],
        resolvePluginSetupCliBackend: ({ backend }) => {
          setupLookups += 1;
          return backend === "claude-cli"
            ? {
                pluginId: "anthropic",
                backend: cliBackend,
              }
            : undefined;
        },
      });
      const resolved = resolveActiveFallbackState({
        selectedModelRef: selectedModelRef ?? "demo-primary/model-a",
        activeModelRef: activeModelRef ?? "demo-fallback/model-b",
        config: {},
        state,
      });

      expect(resolved).toEqual({ active, reason: active ? "rate limit" : undefined });
      expect(setupLookups).toBe(expectedSetupLookups);
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

  it("prefers formatted transient error details over generic rate-limit labels", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [
        {
          ...baseAttempt,
          error: "429 Too Many Requests: Claude Max usage limit reached, try again in 6 minutes.",
        },
      ],
    });

    expect(resolved.reasonSummary).toContain("HTTP 429: Too Many Requests");
    expect(resolved.reasonSummary).toContain("Claude Max usage limit reached");
  });

  it("preserves throttle-flavored transient details over the generic rate-limit label", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, error: "ThrottlingException: Too many concurrent requests" }],
    });

    expect(resolved.reasonSummary).toContain("ThrottlingException");
    expect(resolved.reasonSummary).not.toBe("rate limit");
  });

  it("still collapses to the reason label when a transient reason lacks any transient-detail hint", () => {
    // 防止过度匹配: 修复不得让门控对无 transient 提示的文本也放行。
    const resolved = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, error: "Unauthorized: invalid API key" }],
    });

    expect(resolved.reasonSummary).toBe("rate limit");
  });

  it("keeps truncated transient error details UTF-16 safe", () => {
    const detail = "x".repeat(68);
    const resolved = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, error: `429 ${detail}😀tail` }],
    });

    expect(resolved.reasonSummary).toBe(`HTTP 429: ${detail}…`);
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
    registerAnthropicCliBackendForTest();

    const resolved = resolveFallbackTransition(cliAliasTransition);

    expect(resolved).toMatchObject({
      fallbackActive: false,
      fallbackCleared: false,
      stateChanged: true,
      nextState: { selectedModel: undefined, activeModel: undefined },
    });
  });

  it("does not repeat runtime alias comparison when persisted fallback refs match", () => {
    let setupBackendLookups = 0;
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend }) => {
        setupBackendLookups += 1;
        return backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: cliBackend,
            }
          : undefined;
      },
      resolvePluginSetupRegistry: () => {
        throw new Error("full setup registry should not load for a single runtime alias");
      },
      resolveRuntimeCliBackends: () => [],
    });

    const resolved = resolveFallbackTransition(cliAliasTransition);

    expect(resolved.fallbackActive).toBe(false);
    expect(setupBackendLookups).toBe(2);
  });

  describe("Arcee wire identity", () => {
    it.each([
      {
        name: "fresh state",
        state: {} satisfies FallbackNoticeState,
        expectedStateChanged: false,
      },
      {
        name: "captured alias-only state",
        state: noticeState(
          "arcee/trinity-large-preview",
          "arcee/arcee-ai/trinity-large-preview",
          "selected model unavailable",
        ),
        expectedStateChanged: true,
      },
    ])("keeps $name out of fallback state", ({ state, expectedStateChanged }) => {
      const params = {
        selectedProvider: "arcee",
        selectedModel: "trinity-large-preview",
        activeProvider: "arcee",
        activeModel: "arcee-ai/trinity-large-preview",
        attempts: [],
        cfg: {},
        state,
      };

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
          selectedModelRef: "arcee/trinity-large-preview",
          activeModelRef: "arcee/arcee-ai/trinity-large-preview",
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
      const params = {
        selectedProvider: "arcee",
        selectedModel: "trinity-large-preview",
        activeProvider,
        activeModel,
        attempts: [],
        cfg: {},
        state: {},
      };

      const resolved = resolveFallbackTransition(params);

      expect(resolved).toMatchObject({
        fallbackActive: true,
        fallbackTransitioned: true,
        fallbackCleared: false,
        stateChanged: true,
        nextState: {
          selectedModel: "arcee/trinity-large-preview",
          activeModel: activeRef,
        },
      });
      expect(buildFallbackNotice(params)).toContain(activeRef);
      expect(
        resolveActiveFallbackState({
          selectedModelRef: "arcee/trinity-large-preview",
          activeModelRef: activeRef,
          config: {},
          state: noticeState(
            "arcee/trinity-large-preview",
            activeRef,
            "selected model unavailable",
          ),
        }),
      ).toEqual({ active: true, reason: "selected model unavailable" });
    });
  });
});
