import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedAgentCredentialMode } from "../agents/agent-auth-credential-modes.js";
import { dualRoutes } from "../agents/model-auth-availability.test-support.js";
import * as openaiRoutes from "../agents/openai-model-routes.js";
import { setPreparedModelRuntimeAuthStore } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createStatusModelAuthResolver } from "./status-model-auth.js";

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
    inlineProviderModels: [],
    createStores() {
      throw new Error("Status must not execute a model");
    },
  };
  setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
  return createStatusModelAuthResolver({
    cfg: config,
    agentId: "main",
    agentDir: owner.agentDir,
    workspaceDir: "/tmp/status-workspace",
    sessionEntry: options.sessionEntry,
    owner,
  });
}

describe("native status authentication", () => {
  beforeEach(() => vi.spyOn(openaiRoutes, "resolveOpenAIModelRoutes").mockReturnValue(dualRoutes));
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["api_key", "api-key (codex)"],
    ["oauth", "oauth (codex)"],
    ["token", "token (codex)"],
  ] as const)("renders the prepared %s mode without a host credential", async (mode, label) => {
    expect(await statusAuth({ source: "native", mode })(selection)).toBe(label);
  });

  it("does not describe an absent or retired native login as authenticated", async () => {
    expect(await statusAuth()(selection)).toBe("unknown");
    expect(
      await statusAuth({ source: "native", mode: "api_key" }, { current: () => false })(selection),
    ).toBe("unknown");
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
      ).toBe(label);
    },
  );

  it("does not borrow a local mode for a remote account with an unknown mode", async () => {
    expect(
      await statusAuth(
        { source: "native", mode: "oauth" },
        { nativeDiscovery: { accountType: "chatgpt" } },
      )(selection),
    ).toBe("native (codex)");
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
    ).toBe("unknown");
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
    ).toBe("unknown");
  });

  it("respects an explicitly empty account order", async () => {
    expect(
      await statusAuth(
        { source: "native", mode: "api_key" },
        {
          config: { ...cfg, auth: { order: { openai: [] } } },
        },
      )(selection),
    ).toBe("unknown");
  });
});
