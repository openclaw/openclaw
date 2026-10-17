// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
} from "../../test-helpers/chat-model.ts";
import {
  normalizeChatFastModeInput,
  resolveChatModelUnavailableReason,
  resolveChatFastModeSelectState,
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./model-select-state.ts";

type ChatModelStateInput = Parameters<typeof resolveChatModelSelectState>[0];

function catalogModel(
  id: string,
  name: string,
  provider = "openai",
  fields: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry {
  return { id, name, provider, ...fields };
}

function defaultSession(
  model: string,
  modelProvider: string,
  fields: Parameters<typeof createSessionsListResult>[0] = {},
) {
  return createSessionsListResult({
    model,
    modelProvider,
    defaultsModel: model,
    defaultsProvider: modelProvider,
    ...fields,
  });
}

function createChatModelState(
  params: Partial<Omit<ChatModelStateInput, "sessionKey">> = {},
): ChatModelStateInput {
  const sessionsResult =
    params.sessionsResult ?? createSessionsListResult({ model: null, modelProvider: null });
  return {
    activeSession: params.activeSession ?? sessionsResult.sessions[0],
    sessionKey: "main",
    modelOverrides: {},
    chatModelCatalog: [],
    sessionsResult,
    ...params,
  };
}

type FastModeSelectInput = Parameters<typeof resolveChatFastModeSelectState>[0];

function resolveFastModeSelection(
  input: Pick<FastModeSelectInput, "sessionsResult"> & Partial<FastModeSelectInput>,
) {
  return resolveChatFastModeSelectState({
    catalog: [],
    connected: true,
    currentModelOverride: "",
    fastModeTarget: input.sessionsResult?.sessions[0],
    gatewayAvailable: true,
    loading: false,
    ...input,
  });
}

function fastRoute(id: string, name: string, fields: Partial<ModelCatalogEntry>) {
  return {
    sessionsResult: null,
    currentModelOverride: `openai/${id}`,
    fastModeTarget: { model: id, modelProvider: "openai", fastMode: "ultrafast" as const },
    catalog: [catalogModel(id, name, "openai", fields)],
  };
}

describe("chat-model-select-state", () => {
  it.each([
    { reason: "auth-failed", expected: "auth-failed" },
    { reason: "cooldown", expected: "cooldown" },
  ] as const)("preserves the recorded $reason availability reason", ({ reason, expected }) => {
    const catalog = [
      catalogModel("gpt-5.6-luna", "GPT-5.6 Luna", "openai", {
        available: false,
        unavailableReason: reason,
      }),
    ];
    expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe(expected);
    expect(resolveChatModelUnavailableReason("other-model", "openai", catalog)).toBeUndefined();
  });

  it("does not let an auth-failed alias override a recovering route", () => {
    const catalog = [
      catalogModel("gpt-5.6-luna", "GPT-5.6 Luna", "codex", {
        available: false,
        unavailableReason: "auth-failed",
      }),
      catalogModel("gpt-5.6-luna", "GPT-5.6 Luna", "openai", {
        available: false,
        unavailableReason: "cooldown",
      }),
    ];
    expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe("cooldown");
  });

  it("uses the server-qualified value when the active session provider is present", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "deepseek",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("keeps the active model value but does not synthesize a picker option when the catalog is empty", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "zai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([]);
  });

  it("preserves all-cold route labels and options beside a cold legacy alias", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        catalogModel("gpt-5.5", "GPT-5.5", "openai", { available: false }),
        catalogModel("gpt-5.5", "GPT-5.5", "codex", { available: false }),
      ),
      sessionsResult: defaultSession("gpt-5.5", "codex"),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.5");
    expect(resolved.defaultModel).toBe("openai/gpt-5.5");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5.5", label: "GPT-5.5 · openai", disabled: true },
      { value: "codex/gpt-5.5", label: "GPT-5.5 · codex", disabled: true },
    ]);
  });

  it("keeps an all-cold default identity visible as a disabled option", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        catalogModel("gpt-5.6-sol", "GPT-5.6 Sol", "openai", {
          available: false,
          unavailableReason: "missing-auth",
        }),
        catalogModel("gpt-5.6-luna", "GPT-5.6 Luna", "openai", {
          available: false,
          unavailableReason: "missing-auth",
        }),
      ),
      sessionsResult: defaultSession("gpt-5.6-sol", "openai"),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultLabel).toBe("Default (GPT-5.6 Sol)");
    expect(resolveChatModelUnavailableReason("gpt-5.6-sol", "openai", state.chatModelCatalog)).toBe(
      "missing-auth",
    );
    expect(resolved.options).toEqual([
      {
        value: "openai/gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        disabled: true,
        unavailableReason: "missing-auth",
      },
      {
        value: "openai/gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        disabled: true,
        unavailableReason: "missing-auth",
      },
    ]);
  });

  it("supports fast mode for a default legacy Codex provider", () => {
    const sessionsResult = defaultSession("gpt-5.5", "codex");

    expect(
      resolveFastModeSelection({
        currentModelOverride: "",
        sessionsResult,
      }).supported,
    ).toBe(true);
  });

  it("uses the session provider with an ambiguous raw-id catalog", () => {
    const model = "google/gemma-4-26b-a4b-it";
    const sessionsResult = defaultSession(model, "xai");

    expect(
      resolveFastModeSelection({
        catalog: ["xai", "proxy"].map((provider) => ({ id: model, name: "Gemma", provider })),
        currentModelOverride: model,
        sessionsResult,
      }).supported,
    ).toBe(true);
  });

  it("does not restore a session provider rejected by relevant catalog metadata", () => {
    const sessionsResult = defaultSession("vendor/model", "openrouter");

    expect(
      resolveFastModeSelection({
        catalog: [
          catalogModel("vendor/model", "Vendor Model", "proxy-a"),
          catalogModel("vendor/model", "Vendor Model", "proxy-b"),
        ],
        currentModelOverride: "vendor/model",
        sessionsResult,
      }).supported,
    ).toBe(false);
  });

  it("uses catalog names for the default label and matching picker options", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        catalogModel("moonshotai/kimi-k2.5", "Kimi K2.5 (NVIDIA)", "nvidia", {
          alias: "Kimi K2.5 (NVIDIA)",
        }),
      ),
      sessionsResult: defaultSession("moonshotai/kimi-k2.5", "nvidia"),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("nvidia/moonshotai/kimi-k2.5");
    expect(resolved.defaultLabel).toBe("Default (Kimi K2.5 (NVIDIA))");
    expect(resolved.options).toEqual([
      {
        value: "nvidia/moonshotai/kimi-k2.5",
        label: "Kimi K2.5 (NVIDIA)",
      },
    ]);
  });

  it("keeps versioned catalog names visible for configured family aliases", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        catalogModel("claude-opus-4-8", "Opus 4.8", "anthropic", { alias: "opus" }),
        catalogModel("claude-sonnet-5", "Sonnet 5", "anthropic", { alias: "sonnet" }),
        catalogModel("moonshotai/kimi-k2.5", "Kimi K2.5", "nvidia", {
          alias: "Kimi K2.5 (NVIDIA)",
        }),
      ),
      sessionsResult: defaultSession("claude-opus-4-8", "anthropic"),
    });

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.defaultLabel).toBe("Default (Opus 4.8 · opus)");
    expect(resolved.options).toEqual([
      { value: "anthropic/claude-opus-4-8", label: "Opus 4.8 · opus" },
      { value: "anthropic/claude-sonnet-5", label: "Sonnet 5 · sonnet" },
      {
        value: "nvidia/moonshotai/kimi-k2.5",
        label: "Kimi K2.5 (NVIDIA)",
      },
    ]);
  });

  it("uses the active agent model for the default label", () => {
    const state = createChatModelState({
      agentDefaultModel: "anthropic/claude-opus-4-5",
      chatModelCatalog: createModelCatalog(
        catalogModel("gpt-5.5", "GPT-5.5"),
        catalogModel("claude-opus-4-5", "Claude Opus 4.5", "anthropic"),
      ),
      sessionsResult: createSessionsListResult({
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
        model: "claude-opus-4-5",
        modelProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultModel).toBe("anthropic/claude-opus-4-5");
    expect(resolved.defaultLabel).toBe("Default (Claude Opus 4.5)");
  });

  it("preserves a user pin when the agent default grows into the same model", () => {
    const state = createChatModelState({
      agentDefaultModel: "openai/gpt-5.6-sol",
      chatModelCatalog: createModelCatalog(catalogModel("gpt-5.6-sol", "GPT-5.6 Sol")),
      sessionsResult: defaultSession("gpt-5.6-sol", "openai", {
        modelOverrideSource: "user",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.6-sol");
    expect(resolved.modelOverrideSource).toBe("user");
  });

  // `currentOverride` already lets a pending local selection outrank the row, so
  // provenance has to follow it — otherwise the picker would report a model and an
  // origin belonging to two different points in time.
  it("keeps provenance and the effective model on the same in-flight selection", () => {
    const pendingPin = createChatModelState({
      modelOverrides: { main: "openai/gpt-5-mini" },
      sessionsResult: createSessionsListResult({
        model: "gpt-5",
        modelProvider: "openai",
        modelOverrideSource: null,
      }),
    });

    expect(resolveChatModelSelectState(pendingPin).currentOverride).toBe("openai/gpt-5-mini");
    expect(resolveChatModelSelectState(pendingPin).modelOverrideSource).toBe("user");

    const pendingReset = {
      ...pendingPin,
      modelOverrides: { main: null },
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
        modelOverrideSource: "user" as const,
      }),
    };

    expect(resolveChatModelSelectState(pendingReset).currentOverride).toBe("");
    expect(resolveChatModelSelectState(pendingReset).modelOverrideSource).toBeNull();
  });

  it("falls back to id and provider when duplicate names share the same provider", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        catalogModel("claude-3-7-sonnet", "Claude Sonnet", "anthropic"),
        catalogModel("claude-3-7-sonnet-thinking", "Claude Sonnet", "anthropic"),
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet-thinking",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe(
      "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
    );
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
      },
      {
        value: "anthropic/claude-3-7-sonnet-thinking",
        label: "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
      },
    ]);
  });
});

it("keeps a saved off preference clearable on a no-op route", () => {
  const sessionsResult = createSessionsListResult({
    model: "claude-sonnet-5",
    modelProvider: "anthropic",
  });
  const session = expectDefined(sessionsResult.sessions[0], "Fast applicability session");
  expect(
    resolveFastModeSelection({
      currentModelOverride: "anthropic/claude-sonnet-5",
      sessionsResult,
      fastModeTarget: { ...session, fastMode: false },
      catalog: [
        { id: "claude-sonnet-5", name: "Sonnet 5", provider: "anthropic", supportsFastMode: false },
        { id: "claude-opus-5", name: "Opus 5", provider: "anthropic", supportsFastMode: true },
      ],
    }),
  ).toMatchObject({ supported: true, disabled: false, nextValue: "" });
});

describe("chat-model-select-state", () => {
  it("retains current Fast support without offering a denied model", () => {
    const supportsFastMode = true;
    const catalog = [
      {
        id: "automatic",
        name: "Automatic model",
        provider: "anthropic",
        manualSelectionAllowed: false,
        supportsFastMode,
      },
      { id: "manual", name: "Manual model", provider: "anthropic", manualSelectionAllowed: true },
      { id: "legacy", name: "Older server model", provider: "anthropic" },
    ];
    const sessionsResult = defaultSession("automatic", "anthropic");
    const selection = resolveChatModelSelectState(
      createChatModelState({
        chatModelCatalog: catalog,
        sessionsResult,
      }),
    );
    expect(selection.options.map((option) => option.value)).toEqual([
      "anthropic/manual",
      "anthropic/legacy",
    ]);
    expect(selection.defaultLabel).toContain("Automatic model");
    expect(
      resolveFastModeSelection({
        catalog,
        currentModelOverride: "anthropic/automatic",
        fastModeTarget: sessionsResult.sessions[0],
        sessionsResult,
      }),
    ).toMatchObject({ supported: supportsFastMode, disabled: !supportsFastMode });
  });
});

describe("chat-model-select-state service tiers", () => {
  it("requires current runtime access before showing Ultrafast", () => {
    const runtimeId = "openclaw";
    const otherRuntimeId = "codex";
    const model = {
      id: "model",
      name: "Model",
      provider: "openai",
      available: true,
      agentRuntime: { id: runtimeId, source: "model" as const },
      supportsFastMode: true,
      serviceTiers: ["priority", "ultrafast"],
    };
    const input = {
      sessionsResult: createSessionsListResult({ model: "model", modelProvider: "openai" }),
      currentModelOverride: "openai/model",
      fastModeTarget: {
        model: "model",
        modelProvider: "openai",
        fastMode: "ultrafast" as const,
        agentRuntime: { id: runtimeId, source: "session" as const },
      },
    };
    expect(normalizeChatFastModeInput("ultrafast")).toBe("ultrafast");
    expect(resolveFastModeSelection({ ...input, catalog: [model] })).toMatchObject({
      ultrafastSupported: true,
      currentOverride: "ultrafast",
      label: "Ultrafast",
      active: true,
    });
    for (const catalog of [
      [],
      [{ ...model, supportsFastMode: false }],
      [{ ...model, serviceTiers: undefined }],
      [{ ...model, available: undefined }],
      [{ ...model, available: false }],
      [{ ...model, id: "another-model" }],
      [{ ...model, agentRuntime: { id: otherRuntimeId, source: "model" as const } }],
    ]) {
      expect(resolveFastModeSelection({ ...input, catalog })).toMatchObject({
        ultrafastSupported: undefined,
        currentOverride: "ultrafast",
        label: "Ultrafast",
      });
    }
    // Runtime alternatives are complete projections, not overlays on the base route.
    const catalog = [
      {
        ...model,
        runtimeChoices: [
          {
            agentRuntime: { id: otherRuntimeId, source: "model" as const },
            available: true,
            supportsFastMode: true,
          },
        ],
      },
    ];
    expect(
      resolveFastModeSelection({
        ...input,
        catalog,
        fastModeTarget: {
          ...input.fastModeTarget,
          agentRuntime: { id: otherRuntimeId, source: "session" },
        },
      }),
    ).toMatchObject({ ultrafastSupported: undefined, label: "Ultrafast" });
    expect(
      resolveFastModeSelection({
        ...input,
        catalog: [
          {
            ...model,
            serviceTiers: undefined,
            runtimeChoices: [
              {
                agentRuntime: { id: otherRuntimeId, source: "model" },
                available: true,
                supportsFastMode: true,
                serviceTiers: ["priority", "ultrafast"],
              },
            ],
          },
        ],
        fastModeTarget: {
          ...input.fastModeTarget,
          agentRuntime: { id: otherRuntimeId, source: "session" },
        },
      }),
    ).toMatchObject({ ultrafastSupported: true, label: "Ultrafast" });
  });
});

it("uses Standard for a model's authoritative Standard-only capability without confusing configured tiers", () => {
  for (const fastMode of [true, "auto", "ultrafast", undefined] as const) {
    const input = {
      sessionsResult: createSessionsListResult({ model: "standard-only", modelProvider: "openai" }),
      currentModelOverride: "openai/standard-only",
      fastModeTarget: { model: "standard-only", modelProvider: "openai", fastMode },
      catalog: [
        {
          id: "standard-only",
          name: "Standard model",
          provider: "openai",
          available: true,
          supportsFastMode: false,
          serviceTiers: ["default"],
        },
      ],
    };
    expect(resolveFastModeSelection(input)).toMatchObject({
      active: false,
      currentOverride: "off",
      label: "Standard",
      disabled: true,
      supported: true,
      ultrafastSupported: false,
    });
    expect(
      resolveFastModeSelection({
        ...input,
        catalog: input.catalog.map((entry) =>
          Object.assign({}, entry, {
            serviceTiers: ["priority", "ultrafast"],
          }),
        ),
      }),
    ).toMatchObject({ disabled: !fastMode });
  }
});

it("downgrades saved Ultrafast when the selected route offers Standard and Fast", () => {
  const state = resolveFastModeSelection(
    fastRoute("fast-only", "Fast model", {
      supportsServiceTierRecovery: true,
      available: true,
      supportsFastMode: true,
      serviceTiers: ["default", "priority"],
    }),
  );
  expect(state).toMatchObject({
    active: true,
    currentOverride: "on",
    label: "Fast",
    disabled: false,
    ultrafastSupported: false,
  });
});

it("shows Standard after the selected account loses optional tiers", () => {
  const state = resolveFastModeSelection(
    fastRoute("account-limited", "Account-limited model", {
      supportsServiceTierRecovery: true,
      available: true,
      supportsFastMode: true,
      serviceTiers: ["default"],
    }),
  );
  expect(state).toMatchObject({
    active: false,
    currentOverride: "off",
    label: "Standard",
    disabled: true,
    supported: true,
    ultrafastSupported: false,
  });
});

it("preserves the wire preference without route recovery capability", () => {
  const state = resolveFastModeSelection(
    fastRoute("custom-endpoint", "Custom endpoint", {
      available: true,
      agentRuntime: { id: "openclaw", source: "model" },
      supportsFastMode: true,
      supportsServiceTierRecovery: false,
      serviceTiers: ["priority"],
    }),
  );
  expect(state).toMatchObject({
    currentOverride: "ultrafast",
    label: "Ultrafast",
    ultrafastSupported: false,
  });
});
