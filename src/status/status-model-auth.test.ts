import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedAgentCredentialMode } from "../agents/agent-auth-credential-modes.js";
import * as authProfiles from "../agents/auth-profiles.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { dualRoutes } from "../agents/model-auth-availability.test-support.js";
import * as modelCatalogDecisions from "../agents/model-catalog-decisions.js";
import * as openaiRoutes from "../agents/openai-model-routes.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createStatusModelResolver } from "./status-model-auth.js";

const cfg: OpenClawConfig = {
  plugins: { entries: { codex: { enabled: true } } },
  agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } } },
};
const selection = {
  provider: "openai",
  model: "gpt-5.4",
  runtimeId: "codex",
  acceptedProviderIds: ["openai"],
};
function statusAuth(
  mode?: PreparedAgentCredentialMode,
  options: {
    current?: () => boolean;
    sessionEntry?: SessionEntry;
    config?: OpenClawConfig;
    nativeDiscovery?: { accountType: string; authMode?: string };
    profiles?: AuthProfileStore["profiles"];
  } = {},
) {
  const config = options.config ?? cfg;
  const entry = {
    provider: "openai",
    id: "gpt-5.4",
    name: "GPT",
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
        runAttempt: async () => {
          throw new Error("Status must not execute a model");
        },
      },
    });
  }
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    pluginRegistry,
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/status-workspace" },
    agentId: "main",
    agentDir: "/tmp/status-agent",
    workspaceDir: "/tmp/status-workspace",
    activeProjectKeys: [],
    authModes: mode ? { codex: mode } : {},
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
    }),
    isCurrent: options.current ?? (() => true),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores() {
      throw new Error("Status must not execute a model");
    },
  };
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: options.profiles ?? {} } });
  return createStatusModelResolver({
    cfg: config,
    agentId: "main",
    agentDir: owner.agentDir,
    workspaceDir: "/tmp/status-workspace",
    sessionEntry: options.sessionEntry,
    owner,
  });
}

describe("status model authentication and endpoint", () => {
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
      expect(await statusAuth({ source: "native", mode }, { nativeDiscovery })(selection)).toEqual({
        authLabel,
        endpoint,
      });
    },
  );

  it.each(["display override", "configured key"] as const)(
    "pairs the built-in API-key route with %s despite an OAuth label or profile",
    async (source) => {
      const override = source === "display override";
      const profiles: AuthProfileStore["profiles"] = override
        ? { "openai:test": { type: "api_key", provider: "openai", key: "synthetic-key" } }
        : {
            "openai:chatgpt": {
              type: "oauth",
              provider: "openai",
              access: "native-access",
              refresh: "native-refresh",
              expires: Date.now() + 60_000,
            },
          };
      if (!override) {
        vi.spyOn(authProfiles, "loadAuthProfileStoreWithoutExternalProfiles").mockReturnValue({
          version: 1,
          profiles,
        });
      }
      const resolve = statusAuth(undefined, {
        profiles,
        config: override
          ? cfg
          : {
              ...cfg,
              models: {
                providers: {
                  openai: {
                    auth: "api-key",
                    apiKey: "configured-platform-key",
                    baseUrl: "https://api.openai.com/v1",
                    models: [],
                  },
                },
              },
            },
      });
      expect(
        await resolve({
          ...selection,
          runtimeId: "openclaw",
          ...(override ? { authLabelOverride: "oauth (personal account)" } : {}),
        }),
      ).toEqual({
        authLabel: override ? "oauth (personal account)" : "api-key",
        endpoint: "https://api.openai.com/v1",
      });
    },
  );

  it.each(["openclaw", "codex"])(
    "keeps a pinned personal SIWC account on Responses with %s despite native login",
    async (runtimeId) => {
      const profileId = "personal:gateway-owner:00000000-0000-4000-8000-000000000001";
      const profiles: AuthProfileStore["profiles"] = {
        [profileId]: {
          type: "oauth",
          provider: "openai",
          authFlow: "chatgpt-token-sharing",
          access: "sharing-access",
          refresh: "sharing-refresh",
          expires: Date.now() + 60_000,
          email: "private@example.test",
        },
      };
      vi.spyOn(modelCatalogDecisions, "prepareModelCatalogDecisions").mockImplementation(
        async (params) =>
          modelCatalogDecisions.createModelCatalogDecisions({
            ...params,
            preparedPersonalCatalog: { links: [], profiles: {}, isCurrent: () => true },
          }),
      );
      vi.spyOn(authProfiles, "loadAuthProfileStoreWithoutExternalProfiles").mockReturnValue({
        version: 1,
        profiles,
      });
      const resolve = statusAuth(
        { source: "native", mode: "oauth" },
        {
          profiles,
          nativeDiscovery: { accountType: "chatgpt", authMode: "oauth" },
          sessionEntry: {
            sessionId: "status-personal",
            updatedAt: 1,
            authProfileOverride: profileId,
            authProfileOverrideSource: "user",
            modelProvider: "openai",
          },
        },
      );
      expect(await resolve({ ...selection, runtimeId })).toEqual({
        authLabel: "oauth (personal account)",
        endpoint: "https://api.openai.com/v1",
      });
    },
  );

  it.each<{
    reason: string;
    mode?: PreparedAgentCredentialMode;
    options?: Parameters<typeof statusAuth>[1];
  }>([
    { reason: "absent native login" },
    {
      reason: "retired owner",
      mode: { source: "native", mode: "api_key" },
      options: { current: () => false },
    },
    {
      reason: "unavailable explicit profile",
      mode: { source: "native", mode: "api_key" },
      options: {
        sessionEntry: {
          sessionId: "status-pin",
          updatedAt: 1,
          authProfileOverride: "openai:missing",
          authProfileOverrideSource: "user",
          modelProvider: "openai",
        },
      },
    },
    {
      reason: "explicitly empty account order",
      mode: { source: "native", mode: "api_key" },
      options: { config: { ...cfg, auth: { order: { openai: [] } } } },
    },
  ])("reports unknown authentication for $reason", async ({ mode, options }) => {
    expect(await statusAuth(mode, options)(selection)).toEqual({ authLabel: "unknown" });
  });
});
