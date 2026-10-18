import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";
import { dualRoutes } from "../agents/model-auth-availability.test-support.js";
import * as modelCatalogDecisions from "../agents/model-catalog-decisions.js";
import { createModelRuntimeChoiceOwnerFixture } from "../agents/model-runtime-choice.test-support.js";
import * as openaiRoutes from "../agents/openai-model-routes.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createStatusModelResolver } from "./status-model-auth.js";

const cfg: OpenClawConfig = {
  plugins: { entries: { codex: { enabled: true } } },
  agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } } },
};
const platformEndpoint = "https://api.openai.com/v1";
function credentialConfig(apiKey: string, auth?: "api-key"): OpenClawConfig {
  const openai = { baseUrl: platformEndpoint, models: [], apiKey, ...(auth ? { auth } : {}) };
  return { models: { providers: { openai } } };
}
function oauthProfile(patch: Partial<OAuthCredential> = {}) {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "native-access",
    refresh: "native-refresh",
    expires: Date.now() + 60_000,
    ...patch,
  };
}
const pinnedProfile = (id: string): SessionEntry => ({
  sessionId: "status-pin",
  updatedAt: 1,
  authProfileOverride: id,
  authProfileOverrideSource: "user",
  modelProvider: "openai",
});
function noModelExecution(): never {
  throw new Error("Status must not execute a model");
}
function statusAuth(options: {
  mode?: "api_key" | "oauth";
  runtimeId?: string;
  authLabelOverride?: string;
  current?: () => boolean;
  sessionEntry?: SessionEntry;
  config?: OpenClawConfig;
  nativeDiscovery?: { accountType: string; authMode?: string };
  profiles?: AuthProfileStore["profiles"];
  model?: { provider: string; id: string };
}) {
  const config = options.config ?? cfg;
  const entry = {
    provider: "openai",
    id: "gpt-5.4",
    name: "GPT",
    ...options.model,
    ...(options.nativeDiscovery ? { nativeRuntime: "codex" } : {}),
  };
  const pluginRegistry = createEmptyPluginRegistry();
  if (options.nativeDiscovery) {
    pluginRegistry.agentHarnesses.push({
      pluginId: "codex",
      source: "test",
      harness: {
        id: "codex",
        label: "Codex",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        readModelCatalogReadiness: () => options.nativeDiscovery,
        runAttempt: noModelExecution,
      },
    });
  }
  const owner = {
    ...createModelRuntimeChoiceOwnerFixture(
      config,
      options.current,
      {
        pluginRegistry,
        authModes: options.mode ? { codex: { source: "native", mode: options.mode } } : {},
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
        }),
        modelCatalog: { entries: [entry], routeVariants: [entry] },
      },
      { agentDir: "/tmp/status-agent", workspaceDir: "/tmp/status-workspace" },
    ),
    createStores: noModelExecution,
  };
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: options.profiles ?? {} } });
  return createStatusModelResolver({
    cfg: config,
    agentId: "main",
    agentDir: owner.agentDir,
    workspaceDir: "/tmp/status-workspace",
    sessionEntry: options.sessionEntry,
    owner,
  })({
    provider: entry.provider,
    model: entry.id,
    acceptedProviderIds: [entry.provider],
    runtimeId: options.runtimeId ?? "codex",
    ...("authLabelOverride" in options ? { authLabelOverride: options.authLabelOverride } : {}),
  });
}

beforeEach(() => {
  // These fixtures model an absent host credential, even on credentialed devboxes.
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.spyOn(openaiRoutes, "resolveOpenAIModelRoutes").mockReturnValue(dualRoutes);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  ["api_key", undefined, "api-key (codex)", "https://api.openai.com/v1"],
  ["oauth", undefined, "oauth (codex)", "https://chatgpt.com/backend-api/codex"],
  ["oauth", { accountType: "chatgpt", authMode: "oauth" }, "oauth (codex)", undefined],
  ["oauth", { accountType: "apiKey", authMode: "api_key" }, "api-key (codex)", undefined],
  ["oauth", { accountType: "chatgpt", authMode: "token" }, "token (codex)", undefined],
  ["oauth", { accountType: "chatgpt" }, "native (codex)", undefined],
] as const)(
  "renders prepared %s with discovery %j without inventing credentials or routes",
  async (mode, nativeDiscovery, authLabel, endpoint) => {
    expect(await statusAuth({ mode, nativeDiscovery })).toEqual({ authLabel, endpoint });
  },
);

it.each(["display override", "configured key"] as const)(
  "pairs the built-in API-key route with %s despite an OAuth label or profile",
  async (source) => {
    const override = source === "display override";
    const profiles: AuthProfileStore["profiles"] = override
      ? { "openai:test": { type: "api_key", provider: "openai", key: "synthetic-key" } }
      : { "openai:chatgpt": oauthProfile() };
    const result = await statusAuth({
      profiles,
      config: override
        ? cfg
        : { ...cfg, ...credentialConfig("configured-platform-key", "api-key") },
      runtimeId: "openclaw",
      ...(override ? { authLabelOverride: "oauth (personal account)" } : {}),
    });
    expect(result).toEqual({
      authLabel: override ? "oauth (personal account)" : "api-key (models.json)",
      endpoint: "https://api.openai.com/v1",
    });
  },
);

it.each([
  ["configured-key", "models.json"],
  ["ollama-2:bound", "ollama-2:bound"],
])("shows the selected custom-provider credential for %s", async (apiKey, label) => {
  const provider = {
    baseUrl: "http://127.0.0.1:11434",
    api: "ollama" as const,
    models: [],
  };
  const model = { provider: "ollama-2", id: "qwen3:4b" };
  const result = await statusAuth({
    model,
    config: {
      models: {
        providers: {
          ollama: { ...provider, apiKey: "built-in-key" },
          "ollama-2": { ...provider, auth: "api-key", apiKey },
        },
      },
    },
    profiles: {
      "ollama-2:ambient": { type: "api_key", provider: "ollama-2", key: "unused-key" },
      "ollama-2:bound": { type: "api_key", provider: "ollama-2", key: "bound-key" },
    },
    runtimeId: "openclaw",
  });
  expect(result).toEqual({ authLabel: `api-key (${label})`, endpoint: undefined });
});

it("identifies a selected environment credential without exposing its value", async () => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-environment-key");
  const result = await statusAuth({
    config: credentialConfig("OPENAI_API_KEY"),
    runtimeId: "openclaw",
  });
  expect(result).toEqual({ authLabel: "api-key (environment)", endpoint: platformEndpoint });
});

it.each(["openclaw", "codex"])(
  "keeps a pinned personal SIWC account on Responses with %s despite native login",
  async (runtimeId) => {
    const profileId = "personal:gateway-owner:00000000-0000-4000-8000-000000000001";
    const profiles: AuthProfileStore["profiles"] = {
      [profileId]: oauthProfile({
        authFlow: "chatgpt-token-sharing",
        email: "private@example.test",
      }),
    };
    vi.spyOn(modelCatalogDecisions, "prepareModelCatalogDecisions").mockImplementation(
      async (params) =>
        modelCatalogDecisions.createModelCatalogDecisions({
          ...params,
          preparedPersonalCatalog: { links: [], profiles: {}, isCurrent: () => true },
        }),
    );
    const result = await statusAuth({
      mode: "oauth",
      profiles,
      nativeDiscovery: { accountType: "chatgpt", authMode: "oauth" },
      sessionEntry: { ...pinnedProfile(profileId), sessionId: "status-personal" },
      runtimeId,
    });
    expect(result).toEqual({ authLabel: "oauth (personal account)", endpoint: platformEndpoint });
  },
);

it.each([
  ["absent native login", undefined, {}],
  ["retired owner", "api_key", { current: () => false }],
  ["unavailable explicit profile", "api_key", { sessionEntry: pinnedProfile("openai:missing") }],
  [
    "explicitly empty account order",
    "api_key",
    { config: { ...cfg, auth: { order: { openai: [] } } } },
  ],
] satisfies Array<[string, "api_key" | undefined, Parameters<typeof statusAuth>[0]]>)(
  "reports unknown authentication for %s",
  async (_reason, mode, options) => {
    expect(await statusAuth({ mode, ...options })).toEqual({ authLabel: "unknown" });
  },
);
