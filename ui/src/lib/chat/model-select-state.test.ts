// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  normalizeChatFastModeInput,
  resolveChatModelUnavailableReason,
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
} from "./model-select-state.ts";

type ModelInput = Parameters<typeof resolveChatModelSelectState>[0];

function model(
  id: string,
  name: string,
  provider = "openai",
  fields: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry {
  return { id, name, provider, ...fields };
}

function session(
  modelId: string,
  modelProvider: string,
  fields: Parameters<typeof createSessionsListResult>[0] = {},
) {
  return createSessionsListResult({
    model: modelId,
    modelProvider,
    defaultsModel: modelId,
    defaultsProvider: modelProvider,
    ...fields,
  });
}

function modelState(params: Partial<Omit<ModelInput, "sessionKey">> = {}): ModelInput {
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

type FastInput = Parameters<typeof resolveChatFastModeSelectState>[0];

function selectFast(input: Pick<FastInput, "sessionsResult"> & Partial<FastInput>) {
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

function expectFast(
  input: Parameters<typeof selectFast>[0],
  expected: Partial<ReturnType<typeof selectFast>>,
) {
  expect(selectFast(input)).toMatchObject(expected);
}

function fastRoute(fields: Partial<ModelCatalogEntry>, target: FastInput["fastModeTarget"] = {}) {
  return {
    sessionsResult: null,
    currentModelOverride: "openai/model",
    fastModeTarget: {
      model: "model",
      modelProvider: "openai",
      fastMode: "ultrafast" as const,
      ...target,
    },
    catalog: [
      model("model", "Model", "openai", {
        available: true,
        supportsFastMode: true,
        ...fields,
      }),
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

function expectModel(
  params: Partial<ModelInput>,
  expected: Partial<ReturnType<typeof resolveChatModelSelectState>>,
) {
  const { options, ...fields } = expected;
  const resolved = resolveChatModelSelectState(modelState(params));
  expect(resolved).toMatchObject(fields);
  if (options) {
    expect(resolved.options).toEqual(options);
  }
}

type PickerCase = [
  string,
  ModelCatalogEntry[],
  ReturnType<typeof session>,
  Partial<ReturnType<typeof resolveChatModelSelectState>>,
  Partial<ModelInput>?,
];
const option = (value: string, label: string, disabled?: true) => ({
  value,
  label,
  ...(disabled ? { disabled } : {}),
});
it.each<PickerCase>([
  [
    "empty catalog preserves the active value",
    [],
    session("openai/gpt-5-mini", "zai"),
    { currentOverride: "openai/gpt-5-mini", options: [] },
  ],
  [
    "all-cold routes retain the legacy alias",
    ["openai", "codex"].map((provider) =>
      model("gpt-5.5", "GPT-5.5", provider, { available: false }),
    ),
    session("gpt-5.5", "codex"),
    {
      currentOverride: "openai/gpt-5.5",
      defaultModel: "openai/gpt-5.5",
      options: [
        option("openai/gpt-5.5", "GPT-5.5 · openai", true),
        option("codex/gpt-5.5", "GPT-5.5 · codex", true),
      ],
    },
  ],
  [
    "catalog names label the default and picker",
    [
      model("moonshotai/kimi-k2.5", "Kimi K2.5 (NVIDIA)", "nvidia", {
        alias: "Kimi K2.5 (NVIDIA)",
      }),
    ],
    session("moonshotai/kimi-k2.5", "nvidia"),
    {
      currentOverride: "nvidia/moonshotai/kimi-k2.5",
      defaultLabel: "Default (Kimi K2.5 (NVIDIA))",
      options: [option("nvidia/moonshotai/kimi-k2.5", "Kimi K2.5 (NVIDIA)")],
    },
  ],
  [
    "versioned catalog names remain visible with family aliases",
    [
      model("claude-opus-4-8", "Opus 4.8", "anthropic", { alias: "opus" }),
      model("claude-sonnet-5", "Sonnet 5", "anthropic", { alias: "sonnet" }),
      model("moonshotai/kimi-k2.5", "Kimi K2.5", "nvidia", { alias: "Kimi K2.5 (NVIDIA)" }),
    ],
    session("claude-opus-4-8", "anthropic"),
    {
      defaultLabel: "Default (Opus 4.8 · opus)",
      options: [
        option("anthropic/claude-opus-4-8", "Opus 4.8 · opus"),
        option("anthropic/claude-sonnet-5", "Sonnet 5 · sonnet"),
        option("nvidia/moonshotai/kimi-k2.5", "Kimi K2.5 (NVIDIA)"),
      ],
    },
  ],
  [
    "active agent model supplies the default label",
    [model("gpt-5.5", "GPT-5.5"), model("claude-opus-4-5", "Claude Opus 4.5", "anthropic")],
    session("claude-opus-4-5", "anthropic", {
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
    }),
    { defaultModel: "anthropic/claude-opus-4-5", defaultLabel: "Default (Claude Opus 4.5)" },
    { agentDefaultModel: "anthropic/claude-opus-4-5" },
  ],
  [
    "user pin survives an equal agent default",
    [model("gpt-5.6-sol", "GPT-5.6 Sol")],
    session("gpt-5.6-sol", "openai", { modelOverrideSource: "user" }),
    { currentOverride: "openai/gpt-5.6-sol", modelOverrideSource: "user" },
    { agentDefaultModel: "openai/gpt-5.6-sol" },
  ],
  [
    "duplicate names within a provider use id and provider",
    [
      model("claude-3-7-sonnet", "Claude Sonnet", "anthropic"),
      model("claude-3-7-sonnet-thinking", "Claude Sonnet", "anthropic"),
    ],
    session("claude-3-7-sonnet", "anthropic", {
      defaultsModel: "claude-3-7-sonnet-thinking",
    }),
    {
      currentOverride: "anthropic/claude-3-7-sonnet",
      defaultLabel: "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
      options: [
        option("anthropic/claude-3-7-sonnet", "Claude Sonnet · claude-3-7-sonnet · anthropic"),
        option(
          "anthropic/claude-3-7-sonnet-thinking",
          "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
        ),
      ],
    },
  ],
])("%s", (_name, chatModelCatalog, sessionsResult, expected, fields) => {
  expectModel({ chatModelCatalog, sessionsResult, ...fields }, expected);
});

describe("chat-model-select-state", () => {
  it.each(["auth-failed", "cooldown"] as const)(
    "preserves the recorded %s availability reason",
    (reason) => {
      const catalog = [
        model("gpt-5.6-luna", "GPT-5.6 Luna", "openai", {
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
      model("gpt-5.6-luna", "GPT-5.6 Luna", "codex", {
        available: false,
        unavailableReason: "auth-failed",
      }),
      model("gpt-5.6-luna", "GPT-5.6 Luna", "openai", {
        available: false,
        unavailableReason: "cooldown",
      }),
    ];
    expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe("cooldown");
  });

  it("keeps an all-cold default identity visible as a disabled option", () => {
    const identities = [
      ["gpt-5.6-sol", "GPT-5.6 Sol"],
      ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ] as const;
    const unavailable = { available: false, unavailableReason: "missing-auth" as const };
    const state = {
      chatModelCatalog: identities.map(([id, name]) => model(id, name, "openai", unavailable)),
      sessionsResult: session("gpt-5.6-sol", "openai"),
    };

    expect(resolveChatModelUnavailableReason("gpt-5.6-sol", "openai", state.chatModelCatalog)).toBe(
      "missing-auth",
    );
    expectModel(state, {
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
    expectFast({ sessionsResult: session("gpt-5.5", "codex") }, { supported: true });
  });

  it("uses the session provider with an ambiguous raw-id catalog", () => {
    const modelId = "google/gemma-4-26b-a4b-it";
    expectFast(
      {
        catalog: ["xai", "proxy"].map((provider) => ({ id: modelId, name: "Gemma", provider })),
        currentModelOverride: modelId,
        sessionsResult: session(modelId, "xai"),
      },
      { supported: true },
    );
  });

  it("does not restore a session provider rejected by relevant catalog metadata", () => {
    expectFast(
      {
        catalog: ["proxy-a", "proxy-b"].map((provider) =>
          model("vendor/model", "Vendor Model", provider),
        ),
        currentModelOverride: "vendor/model",
        sessionsResult: session("vendor/model", "openrouter"),
      },
      { supported: false },
    );
  });

  it("keeps provenance and the effective model on the same in-flight selection", () => {
    const pendingPin = modelState({
      modelOverrides: { main: "openai/gpt-5-mini" },
      sessionsResult: session("gpt-5", "openai", { modelOverrideSource: null }),
    });

    expect(resolveChatModelSelectState(pendingPin)).toMatchObject({
      currentOverride: "openai/gpt-5-mini",
      modelOverrideSource: "user",
    });

    const pendingReset = {
      ...pendingPin,
      modelOverrides: { main: null },
      sessionsResult: session("gpt-5-mini", "openai", { modelOverrideSource: "user" }),
    };

    expect(resolveChatModelSelectState(pendingReset)).toMatchObject({
      currentOverride: "",
      modelOverrideSource: null,
    });
  });
});

it("keeps a saved off preference clearable on a no-op route", () => {
  const sessionsResult = createSessionsListResult({
    model: "claude-sonnet-5",
    modelProvider: "anthropic",
  });
  const activeSession = expectDefined(sessionsResult.sessions[0], "Fast applicability session");
  expectFast(
    {
      currentModelOverride: "anthropic/claude-sonnet-5",
      sessionsResult,
      fastModeTarget: { ...activeSession, fastMode: false },
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
    model("automatic", "Automatic model", "anthropic", {
      manualSelectionAllowed: false,
      supportsFastMode: true,
    }),
    model("manual", "Manual model", "anthropic", { manualSelectionAllowed: true }),
    model("legacy", "Older server model", "anthropic"),
  ];
  const sessionsResult = session("automatic", "anthropic");
  const selection = resolveChatModelSelectState(
    modelState({ chatModelCatalog: catalog, sessionsResult }),
  );
  expect(selection.options.map((entry) => entry.value)).toEqual([
    "anthropic/manual",
    "anthropic/legacy",
  ]);
  expect(selection.defaultLabel).toContain("Automatic model");
  expectFast(
    {
      catalog,
      currentModelOverride: "anthropic/automatic",
      sessionsResult,
    },
    { supported: true, disabled: false },
  );
});

it("requires current runtime access before showing Ultrafast", () => {
  const input = fastRoute({
    agentRuntime: runtime(),
    serviceTiers: ["priority", "ultrafast"],
  });
  const entry = expectDefined(input.catalog[0], "Runtime entry");
  const selectRuntime = (id: string, catalog: ModelCatalogEntry[]) =>
    selectFast({
      ...input,
      catalog,
      fastModeTarget: { ...input.fastModeTarget, agentRuntime: runtime(id, "session") },
    });
  expect(normalizeChatFastModeInput("ultrafast")).toBe("ultrafast");
  expect(normalizeChatFastModeInput("ultra")).toBe("ultrafast");
  expect(selectRuntime("openclaw", [entry])).toMatchObject({
    ultrafastSupported: true,
    currentOverride: "ultrafast",
    label: "Ultrafast",
    active: true,
  });
  for (const catalog of [
    [],
    [{ ...entry, supportsFastMode: false }],
    [{ ...entry, serviceTiers: undefined }],
    [{ ...entry, available: undefined }],
    [{ ...entry, available: false }],
    [{ ...entry, id: "another-entry" }],
    [{ ...entry, agentRuntime: runtime("codex") }],
  ]) {
    expect(selectRuntime("openclaw", catalog)).toMatchObject({
      ultrafastSupported: undefined,
      currentOverride: "ultrafast",
      label: "Ultrafast",
    });
  }
  // Runtime alternatives are complete projections, not overlays on the base route.
  expect(selectRuntime("codex", [{ ...entry, runtimeChoices: [runtimeChoice()] }])).toMatchObject({
    ultrafastSupported: undefined,
    label: "Ultrafast",
  });
  expect(
    selectRuntime("codex", [
      {
        ...entry,
        serviceTiers: undefined,
        runtimeChoices: [runtimeChoice(["priority", "ultrafast"])],
      },
    ]),
  ).toMatchObject({ ultrafastSupported: true, label: "Ultrafast" });
});

it("uses Standard for a model's authoritative Standard-only capability without confusing configured tiers", () => {
  for (const fastMode of [true, "auto", "ultrafast", undefined] as const) {
    const input = fastRoute({ supportsFastMode: false, serviceTiers: ["default"] }, { fastMode });
    expectFast(input, {
      active: false,
      currentOverride: "off",
      label: "Standard",
      disabled: true,
      supported: true,
      ultrafastSupported: false,
    });
    expectFast(
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
  expectFast(fastRoute({ supportsServiceTierRecovery: true, serviceTiers }), {
    ...expected,
    ultrafastSupported: false,
  });
});

it("preserves the wire preference without route recovery capability", () => {
  expectFast(
    fastRoute({
      agentRuntime: { id: "openclaw", source: "model" },
      supportsServiceTierRecovery: false,
      serviceTiers: ["priority"],
    }),
    { currentOverride: "ultrafast", label: "Ultrafast", ultrafastSupported: false },
  );
});
