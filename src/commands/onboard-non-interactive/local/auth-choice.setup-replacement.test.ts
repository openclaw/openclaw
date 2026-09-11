import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { upsertAuthProfileWithLock } from "../../../agents/auth-profiles/profiles.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../../../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderAuthMethod } from "../../../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

const providerChoice = vi.hoisted(() => vi.fn());
vi.mock("./auth-choice.plugin-providers.runtime.js", () => ({
  authChoicePluginProvidersRuntime: {
    resolveOwningPluginIdsForProviderRef: () => ["openai"],
    resolveProviderPluginChoice: providerChoice,
    resolvePluginProviders: () => [],
  },
}));
vi.mock("../../runtime-plugin-install.js", () => ({
  ensureModelSelectionRuntimePlugins: async ({ cfg }: { cfg: OpenClawConfig }) => ({
    ok: true,
    cfg,
    codexInstalled: false,
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "preserves stored metadata and working credentials with a new key: %s",
  async (newKey) => {
    const stateDir = tempDirs.make("openclaw-noninteractive-replacement-");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    const working = {
      type: "api_key" as const,
      provider: "openai",
      key: "working-key",
      copyToAgents: false,
      metadata: { accountId: "account-a", gatewayId: "gateway-b" },
    };
    const replacement = { ...working, key: "replacement-key" };
    await upsertAuthProfileWithLock({ profileId: "openai:default", credential: working, agentDir });
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { default: true } },
        defaults: { model: "openai/test-model@openai:default" },
      },
    };
    const before = structuredClone(config);
    let calls = 0;
    const method: ProviderAuthMethod = {
      id: "api-key",
      label: "OpenAI key",
      kind: "api_key",
      wizard: { choiceId: "openai-api-key" },
      run: async () => {
        throw new Error("Interactive setup must not run.");
      },
      runNonInteractive: async ({ agentDir: setupAgentDir }) => {
        calls += 1;
        expect(ensureAuthProfileStore(setupAgentDir).profiles["openai:default"]).toEqual(working);
        if (newKey) {
          await upsertAuthProfileWithLock({
            profileId: "openai:default",
            credential: replacement,
            agentDir: setupAgentDir,
          });
        }
        return config;
      },
    };
    providerChoice.mockReturnValue({
      provider: { id: "openai", pluginId: "openai", label: "OpenAI", auth: [method] },
      method,
      wizard: method.wizard,
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const result = await applyNonInteractivePluginProviderChoice({
      nextConfig: config,
      baseConfig: config,
      authChoice: "provider-plugin:openai:api-key",
      opts: newKey ? { openaiApiKey: "replacement-key" } : {},
      runtime,
      target: { agentId: "main", agentDir, workspaceDir: stateDir },
      resolveApiKey: async () => ({ key: "replacement-key", source: "flag" }),
      toApiKeyCredential: () => replacement,
    });
    expect(calls).toBe(1);
    expect(config).toEqual(before);
    const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    expect(store.profiles["openai:default"]).toEqual(working);
    if (!newKey) {
      expect(result).toEqual(before);
      expect(store.profiles).toEqual({ "openai:default": working });
      expect(runtime.error).not.toHaveBeenCalled();
      return;
    }
    expect(result).toBeNull();
    expect(Object.entries(store.profiles)).toContainEqual([
      expect.stringMatching(/^openai:setup-/),
      expect.objectContaining({
        key: "replacement-key",
        metadata: { accountId: "account-a", gatewayId: "gateway-b" },
        setup: expect.objectContaining({
          replacement: true,
          modelRef: "openai/test-model",
          authChoice: "openai-api-key",
        }),
      }),
    ]);
    expect(runtime.error.mock.calls.flat().join("\n")).toContain("saved but inactive");
  },
);
