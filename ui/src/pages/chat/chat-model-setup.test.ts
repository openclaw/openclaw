import { expect, it } from "vitest";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import { resolveChatModelSetup, requiresChatModelSetup } from "./chat-model-setup.ts";

type ModelSetup = Parameters<typeof resolveChatModelSetup>[0];

const loaded = {
  catalog: false,
  connected: true,
  agentsLoaded: true,
  selectedAgentFound: true,
  modelCatalogState: { hasSnapshot: true, status: "ready" as const },
};

it.each([
  ["missing model route", {}, true],
  ["configured model", { agentModel: "openai/gpt-5.4" }, false],
  ["unresolved agent", { agentsLoaded: false, selectedAgentFound: false }, false],
] as const)("requiresChatModelSetup: %s", (_name, overrides, required) => {
  expect(requiresChatModelSetup({ ...loaded, ...overrides })).toBe(required);
});

const active = createActiveSessionPlacement({
  environmentId: "worker:test",
  workspaceBaseManifestRef: "workspace-base",
  remoteWorkspaceDir: "/worker/workspace",
  inference: "worker" as const,
});

it.each(["missing-auth", "auth-failed"] as const)(
  "ignores only Gateway provider credentials for a current worker placement (%s)",
  (unavailableReason) => {
    const catalog = [
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        provider: "openai",
        available: false,
        unavailableReason,
      },
    ];
    const session = {
      key: "agent:main:worker-test",
      kind: "direct" as const,
      updatedAt: 1,
      model: "gpt-4.1-mini",
      modelProvider: "openai",
    };
    const banner = (
      placement?: NonNullable<ModelSetup["activeSession"]>["placement"],
      overrides: Partial<ModelSetup> = {},
    ) =>
      resolveChatModelSetup({
        ...loaded,
        agentModel: "openai/gpt-4.1-mini",
        chatModelCatalog: catalog,
        modelOverrides: {},
        sessionKey: "agent:main:worker-test",
        sessionsResult: null,
        catalogError: null,
        onSetup: () => undefined,
        activeSession: { ...session, placement },
        ...overrides,
      }).modelUnavailableBanner;
    expect(banner()).toBeDefined();
    expect(banner(active)).toBeUndefined();
    expect(
      banner(active, {
        activeSession: {
          ...session,
          modelOverrideSource: "user",
          placement: active,
        },
      }),
    ).toBeUndefined();
    expect(
      banner(active, { modelCatalogState: { ...loaded.modelCatalogState, retired: true } }),
    ).toBeUndefined();
    expect(
      banner(active, {
        modelCatalogState: { ...loaded.modelCatalogState, retired: true },
        catalogError: "Catalog failed",
      }),
    ).toBeDefined();
    expect(
      banner(active, {
        modelCatalogState: {
          ...loaded.modelCatalogState,
          modelSelectionPolicy: { restricted: true, defaultModel: null },
        },
        chatModelCatalog: [],
      }),
    ).toBeDefined();
    expect(banner({ ...active, state: "reclaimed" })).toBeDefined();
    expect(banner({ ...active, state: "local" })).toBeDefined();
    const { inference: _inference, ...proxied } = active;
    expect(banner(proxied)).toBeDefined();
  },
);

it("reads credential readiness from the session's selected runtime route", () => {
  const route = (id: string, ready: boolean) => ({
    agentRuntime: { id, source: "model" as const },
    available: ready,
    ...(ready ? {} : { unavailableReason: "missing-auth" as const }),
  });
  const banner = (base: boolean, choice: boolean, runtime?: string) =>
    resolveChatModelSetup({
      ...loaded,
      agentModel: "anthropic/claude-opus-5-5",
      chatModelCatalog: [
        {
          id: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          provider: "anthropic",
          ...route("openclaw", base),
          runtimeChoices: [route("claude-cli", choice)],
        },
      ],
      modelOverrides: {},
      sessionKey: "agent:main:main",
      sessionsResult: null,
      catalogError: null,
      onSetup: () => undefined,
      activeSession: {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        model: "claude-opus-5-5",
        modelProvider: "anthropic",
        ...(runtime ? { agentRuntime: { id: runtime, source: "session-key" as const } } : {}),
      },
    }).modelUnavailableBanner;

  expect(banner(false, true, "claude-cli")).toBeUndefined();
  expect(banner(false, true)).toBeDefined();
  expect(banner(true, false, "claude-cli")).toBeDefined();
});

it.each(["auth-failed", "cooldown"] as const)(
  "preserves a configured route during %s despite an empty auth inventory",
  (unavailableReason) => {
    const route = { available: false, unavailableReason };
    const model = { id: "model", name: "Model", provider: "example", ...route };
    for (const entry of [
      model,
      {
        ...model,
        unavailableReason: "missing-auth" as const,
        runtimeChoices: [{ ...route, agentRuntime: { id: "openclaw", source: "model" as const } }],
      },
    ]) {
      expect(
        requiresChatModelSetup({
          ...loaded,
          agentModel: "example/model",
          chatModelCatalog: [entry],
          modelAuthStatusResult: { ts: 1, providers: [] },
        }),
      ).toBe(false);
    }
  },
);

const catalogState = (overrides: Partial<ModelSetup["modelCatalogState"]>) => ({
  ...loaded.modelCatalogState,
  ...overrides,
});
const authStatus = (
  ...providers: NonNullable<ModelSetup["modelAuthStatusResult"]>["providers"]
) => ({
  ts: 1,
  providers,
});

it.each([
  ["empty catalog with a configured model", { chatModelCatalog: [] }, false],
  ["empty catalog with no model configured", { chatModelCatalog: [], agentModel: "" }, true],
  ["unavailable built-in default", {}, true],
  ["no catalog snapshot", { modelCatalogState: catalogState({ hasSnapshot: false }) }, false],
  ["catalog loading", { modelCatalogState: catalogState({ status: "loading" }) }, false],
  ["catalog error", { modelCatalogState: catalogState({ status: "error" }) }, false],
  ["catalog refresh failed", { modelCatalogState: catalogState({ refreshFailed: true }) }, false],
  ["uninitialized catalog", { modelCatalogState: catalogState({ initialized: false }) }, false],
  [
    "auth unavailable",
    {
      modelAuthStatusResult: {
        ...authStatus(),
        unavailable: { code: "PREPARED_MODEL_AUTH_UNAVAILABLE", message: "pending" },
      },
    },
    false,
  ],
  ["auth still loading", { modelAuthStatusResult: null }, false],
  ["auth read failed", { modelAuthStatusResult: { ...authStatus(), ts: 0 } }, false],
  [
    "catalog still discovering",
    { modelCatalogState: catalogState({ pendingProviders: ["ollama"] }) },
    false,
  ],
  ["retired catalog", { modelCatalogState: catalogState({ retired: true }) }, false],
  [
    "restricted account",
    {
      modelCatalogState: catalogState({
        modelSelectionPolicy: { restricted: true, defaultModel: null },
      }),
    },
    false,
  ],
  [
    "available local model",
    {
      chatModelCatalog: [
        { id: "local", name: "Local model", provider: "ollama", available: true, local: true },
      ],
    },
    false,
  ],
  [
    "available alternate runtime",
    {
      chatModelCatalog: [
        {
          id: "model",
          name: "Model",
          provider: "example",
          available: false,
          runtimeChoices: [{ available: true, agentRuntime: { id: "openclaw", source: "model" } }],
        },
      ],
    },
    false,
  ],
  [
    "worker-owned inference",
    {
      activeSession: { key: "main", kind: "direct", updatedAt: 1, placement: active },
    },
    false,
  ],
  [
    "saved rejected key",
    {
      modelAuthStatusResult: authStatus({
        provider: "openai",
        displayName: "OpenAI",
        status: "missing",
        profiles: [{ profileId: "openai:default", type: "api_key", status: "missing" }],
      }),
    },
    false,
  ],
  [
    "environment key",
    {
      modelAuthStatusResult: authStatus({
        provider: "openai",
        displayName: "OpenAI",
        status: "static",
        profiles: [],
        apiKey: { source: "env" },
      }),
    },
    false,
  ],
] satisfies [string, Partial<ModelSetup>, boolean][])(
  "handles setup readiness: %s",
  (_name, overrides, expected) => {
    expect(
      requiresChatModelSetup({
        ...loaded,
        agentModel: "openai/test-model",
        chatModelCatalog: [
          { id: "test-model", name: "Test Model", provider: "openai", available: false },
        ],
        modelAuthStatusResult: authStatus(),
        ...overrides,
      }),
    ).toBe(expected);
  },
);
