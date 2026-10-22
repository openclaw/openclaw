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
  const sessionsResult = params.sessionsResult ?? createSessionsListResult();
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

function expectFastMode(
  input: Parameters<typeof resolveFastModeSelection>[0],
  expected: Partial<ReturnType<typeof resolveFastModeSelection>>,
) {
  expect(resolveFastModeSelection(input)).toMatchObject(expected);
}

function fastRoute(
  id: string,
  name: string,
  fields: Partial<ModelCatalogEntry>,
  target: FastModeSelectInput["fastModeTarget"] = {},
) {
  return {
    sessionsResult: null,
    currentModelOverride: `openai/${id}`,
    fastModeTarget: {
      model: id,
      modelProvider: "openai",
      fastMode: "ultrafast" as const,
      ...target,
    },
    catalog: [
      catalogModel(id, name, "openai", { available: true, supportsFastMode: true, ...fields }),
    ],
  };
}

function runtime(id = "openclaw", source: "model" | "session" = "model") {
  return { id, source };
}

function runtimeChoice(serviceTiers?: string[]) {
  return {
    agentRuntime: runtime("codex"),
    available: true,
    supportsFastMode: true,
    serviceTiers,
  };
}

function expectModelState(
  state: ChatModelStateInput,
  expected: Partial<ReturnType<typeof resolveChatModelSelectState>>,
) {
  const { options, ...fields } = expected;
  const resolved = resolveChatModelSelectState(state);
  expect(resolved).toMatchObject(fields);
  if (options) {
    expect(resolved.options).toEqual(options);
  }
}

describe("chat-model-select-state", () => {
  it.each(["auth-failed", "cooldown"] as const)(
    "preserves the recorded %s availability reason",
    (reason) => {
      const catalog = [
        catalogModel("gpt-5.6-luna", "GPT-5.6 Luna", "openai", {
          available: false,
          unavailableReason: reason,
        }),
      ];
      expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe(reason);
      expect(resolveChatModelUnavailableReason("other-model", "openai", catalog)).toBeUndefined();
    },
  );

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
      sessionsResult: defaultSession("deepseek-chat", "deepseek"),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("keeps the active model value but does not synthesize a picker option when the catalog is empty", () => {
    const state = createChatModelState({
      sessionsResult: defaultSession("openai/gpt-5-mini", "zai"),
    });

    expectModelState(state, {
      currentOverride: "openai/gpt-5-mini",
      options: [],
    });
  });

  it("preserves all-cold route labels and options beside a cold legacy alias", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        catalogModel("gpt-5.5", "GPT-5.5", "openai", { available: false }),
        catalogModel("gpt-5.5", "GPT-5.5", "codex", { available: false }),
      ),
      sessionsResult: defaultSession("gpt-5.5", "codex"),
    });

    expectModelState(state, {
      currentOverride: "openai/gpt-5.5",
      defaultModel: "openai/gpt-5.5",
      options: [
        { value: "openai/gpt-5.5", label: "GPT-5.5 · openai", disabled: true },
        { value: "codex/gpt-5.5", label: "GPT-5.5 · codex", disabled: true },
      ],
    });
  });

  it("keeps an all-cold default identity visible as a disabled option", () => {
    const identities = [
      ["gpt-5.6-sol", "GPT-5.6 Sol"],
      ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ] as const;
    const unavailable = { available: false, unavailableReason: "missing-auth" as const };
    const state = createChatModelState({
      chatModelCatalog: identities.map(([id, name]) =>
        catalogModel(id, name, "openai", unavailable),
      ),
      sessionsResult: defaultSession("gpt-5.6-sol", "openai"),
    });

    expect(resolveChatModelUnavailableReason("gpt-5.6-sol", "openai", state.chatModelCatalog)).toBe(
      "missing-auth",
    );
    expectModelState(state, {
      defaultLabel: "Default (GPT-5.6 Sol)",
      options: identities.map(([id, label]) => ({
        value: `openai/${id}`,
        label,
        disabled: true,
        unavailableReason: "missing-auth",
      })),
    });
  });

  it("supports fast mode for a default legacy Codex provider", () => {
    expectFastMode({ sessionsResult: defaultSession("gpt-5.5", "codex") }, { supported: true });
  });

  it("uses the session provider with an ambiguous raw-id catalog", () => {
    const model = "google/gemma-4-26b-a4b-it";
    expectFastMode(
      {
        catalog: ["xai", "proxy"].map((provider) => ({ id: model, name: "Gemma", provider })),
        currentModelOverride: model,
        sessionsResult: defaultSession(model, "xai"),
      },
      { supported: true },
    );
  });

  it("does not restore a session provider rejected by relevant catalog metadata", () => {
    expectFastMode(
      {
        catalog: ["proxy-a", "proxy-b"].map((provider) =>
          catalogModel("vendor/model", "Vendor Model", provider),
        ),
        currentModelOverride: "vendor/model",
        sessionsResult: defaultSession("vendor/model", "openrouter"),
      },
      { supported: false },
    );
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

    expectModelState(state, {
      currentOverride: "nvidia/moonshotai/kimi-k2.5",
      defaultLabel: "Default (Kimi K2.5 (NVIDIA))",
      options: [{ value: "nvidia/moonshotai/kimi-k2.5", label: "Kimi K2.5 (NVIDIA)" }],
    });
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

    expectModelState(state, {
      defaultLabel: "Default (Opus 4.8 · opus)",
      options: [
        { value: "anthropic/claude-opus-4-8", label: "Opus 4.8 · opus" },
        { value: "anthropic/claude-sonnet-5", label: "Sonnet 5 · sonnet" },
        { value: "nvidia/moonshotai/kimi-k2.5", label: "Kimi K2.5 (NVIDIA)" },
      ],
    });
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

    expect(resolveChatModelSelectState(state)).toMatchObject({
      defaultModel: "anthropic/claude-opus-4-5",
      defaultLabel: "Default (Claude Opus 4.5)",
    });
  });

  it("preserves a user pin when the agent default grows into the same model", () => {
    const state = createChatModelState({
      agentDefaultModel: "openai/gpt-5.6-sol",
      chatModelCatalog: createModelCatalog(catalogModel("gpt-5.6-sol", "GPT-5.6 Sol")),
      sessionsResult: defaultSession("gpt-5.6-sol", "openai", {
        modelOverrideSource: "user",
      }),
    });

    expect(resolveChatModelSelectState(state)).toMatchObject({
      currentOverride: "openai/gpt-5.6-sol",
      modelOverrideSource: "user",
    });
  });

  it("keeps provenance and the effective model on the same in-flight selection", () => {
    const pendingPin = createChatModelState({
      modelOverrides: { main: "openai/gpt-5-mini" },
      sessionsResult: defaultSession("gpt-5", "openai", { modelOverrideSource: null }),
    });

    expect(resolveChatModelSelectState(pendingPin)).toMatchObject({
      currentOverride: "openai/gpt-5-mini",
      modelOverrideSource: "user",
    });

    const pendingReset = {
      ...pendingPin,
      modelOverrides: { main: null },
      sessionsResult: defaultSession("gpt-5-mini", "openai", { modelOverrideSource: "user" }),
    };

    expect(resolveChatModelSelectState(pendingReset)).toMatchObject({
      currentOverride: "",
      modelOverrideSource: null,
    });
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

    expectModelState(state, {
      currentOverride: "anthropic/claude-3-7-sonnet",
      defaultLabel: "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
      options: [
        {
          value: "anthropic/claude-3-7-sonnet",
          label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
        },
        {
          value: "anthropic/claude-3-7-sonnet-thinking",
          label: "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
        },
      ],
    });
  });
});

it("keeps a saved off preference clearable on a no-op route", () => {
  const sessionsResult = createSessionsListResult({
    model: "claude-sonnet-5",
    modelProvider: "anthropic",
  });
  const session = expectDefined(sessionsResult.sessions[0], "Fast applicability session");
  expectFastMode(
    {
      currentModelOverride: "anthropic/claude-sonnet-5",
      sessionsResult,
      fastModeTarget: { ...session, fastMode: false },
      catalog: [
        { id: "claude-sonnet-5", name: "Sonnet 5", provider: "anthropic", supportsFastMode: false },
        { id: "claude-opus-5", name: "Opus 5", provider: "anthropic", supportsFastMode: true },
      ],
    },
    { supported: true, disabled: false, nextValue: "" },
  );
});

it("retains current Fast support without offering a denied model", () => {
  const catalog = [
    catalogModel("automatic", "Automatic model", "anthropic", {
      manualSelectionAllowed: false,
      supportsFastMode: true,
    }),
    catalogModel("manual", "Manual model", "anthropic", { manualSelectionAllowed: true }),
    catalogModel("legacy", "Older server model", "anthropic"),
  ];
  const sessionsResult = defaultSession("automatic", "anthropic");
  const selection = resolveChatModelSelectState(
    createChatModelState({ chatModelCatalog: catalog, sessionsResult }),
  );
  expect(selection.options.map((option) => option.value)).toEqual([
    "anthropic/manual",
    "anthropic/legacy",
  ]);
  expect(selection.defaultLabel).toContain("Automatic model");
  expectFastMode(
    {
      catalog,
      currentModelOverride: "anthropic/automatic",
      sessionsResult,
    },
    { supported: true, disabled: false },
  );
});

it("requires current runtime access before showing Ultrafast", () => {
  const input = fastRoute("model", "Model", {
    agentRuntime: runtime(),
    serviceTiers: ["priority", "ultrafast"],
  });
  const model = expectDefined(input.catalog[0], "Runtime model");
  const selectRuntime = (id: string, catalog: ModelCatalogEntry[]) =>
    resolveFastModeSelection({
      ...input,
      catalog,
      fastModeTarget: { ...input.fastModeTarget, agentRuntime: runtime(id, "session") },
    });
  expect(normalizeChatFastModeInput("ultrafast")).toBe("ultrafast");
  expect(selectRuntime("openclaw", [model])).toMatchObject({
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
    [{ ...model, agentRuntime: runtime("codex") }],
  ]) {
    expect(selectRuntime("openclaw", catalog)).toMatchObject({
      ultrafastSupported: undefined,
      currentOverride: "ultrafast",
      label: "Ultrafast",
    });
  }
  // Runtime alternatives are complete projections, not overlays on the base route.
  expect(selectRuntime("codex", [{ ...model, runtimeChoices: [runtimeChoice()] }])).toMatchObject({
    ultrafastSupported: undefined,
    label: "Ultrafast",
  });
  expect(
    selectRuntime("codex", [
      {
        ...model,
        serviceTiers: undefined,
        runtimeChoices: [runtimeChoice(["priority", "ultrafast"])],
      },
    ]),
  ).toMatchObject({ ultrafastSupported: true, label: "Ultrafast" });
});

it("uses Standard for a model's authoritative Standard-only capability without confusing configured tiers", () => {
  for (const fastMode of [true, "auto", "ultrafast", undefined] as const) {
    const input = fastRoute(
      "standard-only",
      "Standard model",
      { supportsFastMode: false, serviceTiers: ["default"] },
      { fastMode },
    );
    expectFastMode(input, {
      active: false,
      currentOverride: "off",
      label: "Standard",
      disabled: true,
      supported: true,
      ultrafastSupported: false,
    });
    expectFastMode(
      {
        ...input,
        catalog: input.catalog.map((entry) =>
          Object.assign({}, entry, { serviceTiers: ["priority", "ultrafast"] }),
        ),
      },
      { disabled: !fastMode },
    );
  }
});

it.each([
  {
    name: "downgrades saved Ultrafast when the selected route offers Standard and Fast",
    serviceTiers: ["default", "priority"],
    expected: { active: true, currentOverride: "on" as const, label: "Fast", disabled: false },
  },
  {
    name: "shows Standard after the selected account loses optional tiers",
    serviceTiers: ["default"],
    expected: {
      active: false,
      currentOverride: "off" as const,
      label: "Standard",
      disabled: true,
      supported: true,
    },
  },
])("$name", ({ serviceTiers, expected }) => {
  expectFastMode(fastRoute("model", "Model", { supportsServiceTierRecovery: true, serviceTiers }), {
    ...expected,
    ultrafastSupported: false,
  });
});

it("preserves the wire preference without route recovery capability", () => {
  expectFastMode(
    fastRoute("custom-endpoint", "Custom endpoint", {
      agentRuntime: { id: "openclaw", source: "model" },
      supportsServiceTierRecovery: false,
      serviceTiers: ["priority"],
    }),
    { currentOverride: "ultrafast", label: "Ultrafast", ultrafastSupported: false },
  );
});
