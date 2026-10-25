// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
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
const option = (value: string, label: string, disabled?: true) => ({
  value,
  label,
  ...(disabled ? { disabled } : {}),
});

it("retains disabled legacy routes with provider-disambiguated names", () => {
  expectModel(
    {
      chatModelCatalog: ["openai", "codex"].map((provider) =>
        model("gpt-5.5", "GPT-5.5", provider, { available: false }),
      ),
      sessionsResult: session("gpt-5.5", "codex"),
    },
    {
      currentOverride: "openai/gpt-5.5",
      defaultModel: "openai/gpt-5.5",
      options: [
        option("openai/gpt-5.5", "GPT-5.5 · openai", true),
        option("codex/gpt-5.5", "GPT-5.5 · codex", true),
      ],
    },
  );
});

it.each([
  ["Model", "Default (Model)", "Model"],
  ["family", "Default (Model · family)", "Model · family"],
  ["Model (custom)", "Default (Model (custom))", "Model (custom)"],
])("labels the default and picker with alias %s", (alias, defaultLabel, label) => {
  expectModel(
    {
      chatModelCatalog: [model("m", "Model", "openai", { alias })],
      sessionsResult: session("m", "openai"),
    },
    {
      currentOverride: "openai/m",
      defaultLabel,
      options: [option("openai/m", label)],
    },
  );
});

it("uses the agent default rather than the global default", () => {
  expectModel(
    {
      chatModelCatalog: [model("global", "Global"), model("agent", "Agent")],
      sessionsResult: session("agent", "openai", { defaultsModel: "global" }),
      agentDefaultModel: "openai/agent",
    },
    { defaultModel: "openai/agent", defaultLabel: "Default (Agent)" },
  );
});

type UnavailableReason = NonNullable<ModelCatalogEntry["unavailableReason"]>;
const unavailableModel = (reason: UnavailableReason, provider = "openai") =>
  model("example", "Example", provider, { available: false, unavailableReason: reason });
const missing = unavailableModel("missing-auth");
const failed = unavailableModel("auth-failed", "codex");
const cooling = unavailableModel("cooldown");
const ready = model("example", "Example", "openai", { available: true });
it.each<[string, ModelCatalogEntry[], UnavailableReason | undefined]>([
  ["missing authentication", [missing], "missing-auth"],
  ["recovering route beats failed alias", [failed, cooling], "cooldown"],
  ["ready first", [ready, missing, failed, cooling], undefined],
  ["ready last", [missing, failed, cooling, ready], undefined],
  ["auth failure first", [failed, missing], "auth-failed"],
  ["auth failure last", [missing, failed], "auth-failed"],
])("resolves availability: %s", (_name, catalog, expected) => {
  expect(resolveChatModelUnavailableReason("example", "openai", catalog)).toBe(expected);
  expect(resolveChatModelUnavailableReason("other", "openai", catalog)).toBeUndefined();
});

it.each<[string, string[], boolean]>([
  ["codex", [], true],
  ["xai", ["xai", "proxy"], true],
  ["openrouter", ["proxy-a", "proxy-b"], false],
])(
  "resolves Fast applicability for %s from the selected catalog",
  (provider, providers, supported) => {
    expectFast(
      {
        catalog: providers.map((route) => model("vendor/model", "Model", route)),
        currentModelOverride: providers.length ? "vendor/model" : "",
        sessionsResult: session("vendor/model", provider),
      },
      { supported },
    );
  },
);

it.each([
  ["openai/gpt-5-mini", "gpt-5", null, "openai/gpt-5-mini", "user"],
  [null, "gpt-5-mini", "user", "", null],
] as const)(
  "keeps an in-flight selection %s and provenance together",
  (pin, previous, source, currentOverride, modelOverrideSource) => {
    expectModel(
      {
        modelOverrides: { main: pin },
        sessionsResult: session(previous, "openai", { modelOverrideSource: source }),
      },
      { currentOverride, modelOverrideSource },
    );
  },
);
it("keeps a saved off preference clearable on a no-op route", () => {
  const sessionsResult = session("claude-sonnet-5", "anthropic");
  const activeSession = expectDefined(sessionsResult.sessions[0], "Fast applicability session");
  expectFast(
    {
      currentModelOverride: "anthropic/claude-sonnet-5",
      sessionsResult,
      fastModeTarget: { ...activeSession, fastMode: false },
      catalog: [
        model("claude-sonnet-5", "Sonnet 5", "anthropic", { supportsFastMode: false }),
        model("claude-opus-5", "Opus 5", "anthropic", { supportsFastMode: true }),
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

it.each<[string[], Partial<ReturnType<typeof selectFast>>]>([
  [
    ["default", "priority"],
    { active: true, currentOverride: "on", label: "Fast", disabled: false },
  ],
  [
    ["default"],
    { active: false, currentOverride: "off", label: "Standard", disabled: true, supported: true },
  ],
])("recovers saved Ultrafast with tiers %j", (serviceTiers, expected) => {
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
