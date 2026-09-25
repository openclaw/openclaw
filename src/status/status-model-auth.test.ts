import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedAgentCredentialMode } from "../agents/agent-auth-credential-modes.js";
import * as authProfiles from "../agents/auth-profiles.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { dualRoutes } from "../agents/model-auth-availability.test-support.js";
import * as openaiRoutes from "../agents/openai-model-routes.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as userModelAccounts from "../state/user-model-accounts.js";
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
    ["api_key", "api-key (codex)", "https://api.openai.com/v1"],
    ["oauth", "oauth (codex)", "https://chatgpt.com/backend-api/codex"],
    ["token", "token (codex)", "https://chatgpt.com/backend-api/codex"],
  ] as const)(
    "renders the prepared %s mode and selected route without a host credential",
    async (mode, authLabel, endpoint) => {
      expect(await statusAuth({ source: "native", mode })(selection)).toEqual({
        authLabel,
        endpoint,
      });
    },
  );

  it("uses the built-in prepared route even when the displayed auth label is overridden", async () => {
    const resolve = statusAuth(undefined, {
      profiles: { "openai:test": { type: "api_key", provider: "openai", key: "synthetic-key" } },
    });
    expect(
      await resolve({
        ...selection,
        runtimeId: "openclaw",
        authLabelOverride: "oauth (personal account)",
      }),
    ).toEqual({
      authLabel: "oauth (personal account)",
      endpoint: "https://api.openai.com/v1",
    });
  });

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
      vi.spyOn(userModelAccounts, "readUserModelAuthProfile").mockReturnValue(undefined);
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

  it("pairs authored API-key routing with its selected auth instead of stored OAuth", async () => {
    const profiles: AuthProfileStore["profiles"] = {
      "openai:chatgpt": {
        type: "oauth",
        provider: "openai",
        access: "native-access",
        refresh: "native-refresh",
        expires: Date.now() + 60_000,
      },
    };
    vi.spyOn(authProfiles, "loadAuthProfileStoreWithoutExternalProfiles").mockReturnValue({
      version: 1,
      profiles,
    });
    const resolve = statusAuth(undefined, {
      profiles,
      config: {
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
    expect(await resolve({ ...selection, runtimeId: "openclaw" })).toEqual({
      authLabel: "api-key",
      endpoint: "https://api.openai.com/v1",
    });
  });

  it("does not infer a native endpoint from account discovery without a route", async () => {
    expect(
      await statusAuth(
        { source: "native", mode: "oauth" },
        { nativeDiscovery: { accountType: "chatgpt", authMode: "oauth" } },
      )(selection),
    ).toEqual({ authLabel: "oauth (codex)", endpoint: undefined });
  });

  it("does not describe an absent or retired native login as authenticated", async () => {
    expect(await statusAuth()(selection)).toEqual({ authLabel: "unknown" });
    expect(
      await statusAuth({ source: "native", mode: "api_key" }, { current: () => false })(selection),
    ).toEqual({ authLabel: "unknown" });
  });

  it.each([
    ["apiKey", "api_key", "api-key (codex)"],
    ["chatgpt", "oauth", "oauth (codex)"],
    ["chatgpt", "token", "token (codex)"],
  ] as const)(
    "renders %s discovery with its observed %s mode",
    async (accountType, authMode, label) => {
      expect(
        await statusAuth(
          { source: "native", mode: "oauth" },
          { nativeDiscovery: { accountType, authMode } },
        )(selection),
      ).toMatchObject({ authLabel: label });
    },
  );

  it("does not borrow a local mode for a remote account with an unknown mode", async () => {
    expect(
      await statusAuth(
        { source: "native", mode: "oauth" },
        { nativeDiscovery: { accountType: "chatgpt" } },
      )(selection),
    ).toEqual({ authLabel: "native (codex)", endpoint: undefined });
  });

  it("rejects a retired discovery observation together with its mode", async () => {
    expect(
      await statusAuth(
        { source: "native", mode: "api_key" },
        {
          nativeDiscovery: { accountType: "apiKey", authMode: "api_key" },
          current: () => false,
        },
      )(selection),
    ).toEqual({ authLabel: "unknown" });
  });

  it("does not substitute native login for an unavailable explicit profile", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "status-pin",
      updatedAt: 1,
      authProfileOverride: "openai:missing",
      authProfileOverrideSource: "user",
      modelProvider: "openai",
    };
    expect(
      await statusAuth({ source: "native", mode: "api_key" }, { sessionEntry })(selection),
    ).toEqual({ authLabel: "unknown" });
  });

  it("respects an explicitly empty account order", async () => {
    expect(
      await statusAuth(
        { source: "native", mode: "api_key" },
        {
          config: { ...cfg, auth: { order: { openai: [] } } },
        },
      )(selection),
    ).toEqual({ authLabel: "unknown" });
  });
});
