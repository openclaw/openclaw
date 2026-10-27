// @vitest-environment node
import { expect, it } from "vitest";
import type { ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  normalizeChatFastModeInput,
  resolveChatModelUnavailableReason,
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  resolveChatModelSelectValues,
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

function modelState(
  params: Partial<Omit<ModelInput, "sessionKey">> & {
    sessionsResult?: SessionsListResult | null;
  } = {},
): ModelInput {
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

type FastState = ReturnType<typeof resolveChatFastModeSelectState>;
function expectFast(
  input: { sessionsResult: SessionsListResult | null } & Partial<Omit<FastInput, "sessionsResult">>,
  expected: Partial<FastState>,
) {
  expect(
    resolveChatFastModeSelectState({
      catalog: [],
      connected: true,
      currentModelOverride: "",
      fastModeTarget: input.sessionsResult?.sessions[0],
      gatewayAvailable: true,
      loading: false,
      ...input,
    }),
  ).toMatchObject(expected);
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

function expectModel(
  params: Parameters<typeof modelState>[0],
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

it.each<[string, ModelCatalogEntry[], string]>([
  [
    "canonical available alias wins even when legacy appears first",
    [
      model("choice", "Legacy", "codex", { available: true }),
      model("choice", "Canonical", "openai", { available: true }),
    ],
    "openai/choice",
  ],
  [
    "available legacy alias wins over unavailable canonical",
    [
      model("choice", "Canonical", "openai", { available: false }),
      model("choice", "Legacy", "codex", { available: true }),
    ],
    "codex/choice",
  ],
  [
    "available automatic-only alias still suppresses an unavailable manual alias",
    [
      model("choice", "Legacy", "codex", { available: false, manualSelectionAllowed: true }),
      model("choice", "Canonical", "openai", { available: true, manualSelectionAllowed: false }),
    ],
    "CODEX/CHOICE",
  ],
  [
    "manual exclusion leaves the available legacy choice",
    [
      model("choice", "Canonical", "openai", { available: true, manualSelectionAllowed: false }),
      model("choice", "Legacy", "codex", { available: true }),
    ],
    "codex/choice",
  ],
  [
    "duplicate canonical identities retain the first available spelling",
    [
      model("Choice", "First", "OpenAI", { available: true }),
      model("choice", "Later", "openai", { available: true }),
      model("choice", "Legacy", "codex", { available: false }),
    ],
    "OpenAI/Choice",
  ],
])("resolves value-only model identities: %s", (_name, catalog, expected) => {
  expect(
    resolveChatModelSelectValues(
      modelState({
        chatModelCatalog: [
          model("unrelated", "Canonical", "other", { alias: "choice", available: true }),
          ...catalog,
        ],
        modelOverrides: { main: "CODEX/CHOICE" },
        modelSelectionPolicy: { restricted: true, defaultModel: "CODEX/CHOICE" },
      }),
    ),
  ).toEqual({ currentOverride: expected, defaultModel: expected });
});

it("preserves unknown value-only model identities instead of matching display aliases", () => {
  expect(
    resolveChatModelSelectValues(
      modelState({
        chatModelCatalog: [model("known", "Known", "openai", { alias: "proxy/retired" })],
        modelOverrides: { main: " proxy/retired " },
        agentDefaultModel: " custom/missing ",
      }),
    ),
  ).toEqual({ currentOverride: "proxy/retired", defaultModel: "custom/missing" });
});

it.each<[string, Partial<Omit<ModelInput, "sessionsResult">>, string]>([
  ["agent before global", {}, "openai/agent"],
  ["global when the agent has no default", { agentDefaultModel: undefined }, "openai/global"],
  [
    "restricted policy before configured defaults",
    { modelSelectionPolicy: { restricted: true, defaultModel: "openai/policy" } },
    "openai/policy",
  ],
  [
    "restricted policy with no permitted default",
    { modelSelectionPolicy: { restricted: true, defaultModel: null } },
    "",
  ],
  ["retired catalog", { catalogRetired: true }, ""],
  ["uninitialized catalog", { catalogInitialized: false }, ""],
])("resolves value-only model defaults: %s", (_name, input, expectedDefault) => {
  expect(
    resolveChatModelSelectValues(
      modelState({
        chatModelCatalog: ["agent", "global", "policy"].map((id) => model(id, id)),
        modelOverrides: { main: null },
        agentDefaultModel: "openai/agent",
        sessionsResult: session("global", "openai"),
        ...input,
      }),
    ),
  ).toEqual({ currentOverride: "", defaultModel: expectedDefault });
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
  expectFast(
    {
      currentModelOverride: "anthropic/claude-sonnet-5",
      sessionsResult,
      fastModeTarget: { ...sessionsResult.sessions[0], fastMode: false },
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

const alternative = { agentRuntime: runtime("codex"), available: true, supportsFastMode: true };
it.each<[Partial<ModelCatalogEntry> | null, string, boolean | undefined]>([
  [{}, "openclaw", true],
  [null, "openclaw", undefined],
  [{ supportsFastMode: false }, "openclaw", undefined],
  [{ serviceTiers: undefined }, "openclaw", undefined],
  [{ available: undefined }, "openclaw", undefined],
  [{ available: false }, "openclaw", undefined],
  [{ id: "another-entry" }, "openclaw", undefined],
  [{ agentRuntime: runtime("codex") }, "openclaw", undefined],
  [{ runtimeChoices: [alternative] }, "codex", undefined],
  [
    {
      serviceTiers: undefined,
      runtimeChoices: [{ ...alternative, serviceTiers: ["priority", "ultrafast"] }],
    },
    "codex",
    true,
  ],
])(
  "requires current runtime access before showing Ultrafast (%j, %s)",
  (fields, id, ultrafastSupported) => {
    // Runtime alternatives are complete projections, not overlays on the base route.
    const input = fastRoute({
      agentRuntime: runtime(),
      serviceTiers: ["priority", "ultrafast"],
      ...fields,
    });
    expectFast(
      {
        ...input,
        catalog: fields === null ? [] : input.catalog,
        fastModeTarget: { ...input.fastModeTarget, agentRuntime: runtime(id, "session") },
      },
      { ultrafastSupported, currentOverride: "ultrafast", label: "Ultrafast", active: true },
    );
  },
);

it.each(["ultra", "ultrafast"])("normalizes %s to Ultrafast", (value) => {
  expect(normalizeChatFastModeInput(value)).toBe("ultrafast");
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
      fastRoute({ supportsFastMode: false, serviceTiers: ["priority", "ultrafast"] }, { fastMode }),
      { disabled: !fastMode },
    );
  }
});

it.each<[string[], Partial<FastState>]>([
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
