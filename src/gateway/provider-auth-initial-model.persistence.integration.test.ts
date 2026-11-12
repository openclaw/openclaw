import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAgentModelFallbacksOverride } from "../agents/agent-scope.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  runModelsAuthLoginFlowCore,
  runModelsAuthLoginFlowForGateway,
} from "../commands/models/auth.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cleanupPluginLoaderFixturesForTest } from "../plugins/loader.test-fixtures.js";
import { updatePluginManifest, writeWorkspacePlugin } from "../plugins/loader.test-harness.js";
import { getPluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { PROVIDER_AUTH_INTEGRATION_ENV } from "./test-helpers.env.js";

const pluginId = "initial-model-proof";
let state: OpenClawTestState | undefined;
afterAll(cleanupPluginLoaderFixturesForTest);
afterEach(async () => {
  getPluginLoaderCacheState().clear();
  resetPluginRuntimeStateForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  await state?.cleanup();
  state = undefined;
});

async function loginFixture(
  options: {
    method?: "oauth" | "api-key" | "identity-only";
    defaults?: NonNullable<OpenClawConfig["agents"]>["defaults"];
    agentModel?: AgentModelConfig;
    agent?: "main" | "coder";
    credentialOnly?: boolean;
    models?: OpenClawConfig["models"];
  } = {},
) {
  state = await createOpenClawTestState({
    label: "provider-initial-model-proof",
    env: { ...PROVIDER_AUTH_INTEGRATION_ENV },
  });
  const apiKey = options.method === "api-key";
  const identityOnly = options.method === "identity-only";
  const agent = options.agent ?? "main";
  const credential = apiKey
    ? { type: "api_key", provider: "openai", key: "fixture-api-key" }
    : {
        type: "oauth",
        provider: "openai",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 2_100_000_000_000,
      };
  const result = {
    profiles: [{ profileId: "openai:initial-proof", credential }],
    ...(!identityOnly
      ? { defaultModel: apiKey ? "openai/gpt-6-astra" : "openai/gpt-6.1-sol" }
      : {}),
    ...(!identityOnly && !apiKey ? { defaultModelSelection: "if-unset" } : {}),
  };
  const { plugin } = writeWorkspacePlugin({
    workspaceDir: state.workspaceDir,
    id: pluginId,
    body: `module.exports = {
      id: ${JSON.stringify(pluginId)},
      register(api) {
        api.registerProvider({
          id: "openai", label: "Initial model proof",
          auth: [{
            id: ${JSON.stringify(options.method ?? "oauth")},
            label: "Fixture sign-in",
            kind: ${JSON.stringify(apiKey ? "api_key" : "oauth")},
            async run() { return ${JSON.stringify(result)}; },
          }],
        });
      },
    };`,
  });
  updatePluginManifest(plugin, { providers: ["openai"] });
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      ...(options.defaults ? { defaults: options.defaults } : {}),
      entries: {
        main: {
          workspace: state.workspaceDir,
          model: agent === "main" ? options.agentModel : undefined,
        },
        ...(agent === "coder"
          ? { coder: { workspace: state.workspaceDir, model: options.agentModel } }
          : {}),
      },
    },
    plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
    ...(options.models ? { models: options.models } : {}),
  };
  await state.writeConfig(config);
  const login =
    options.credentialOnly === false
      ? runModelsAuthLoginFlowCore
      : runModelsAuthLoginFlowForGateway;
  await login({
    provider: "openai",
    method: options.method ?? "oauth",
    agent,
    config,
    credentialOnly: options.credentialOnly ?? true,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: createWizardPrompter(),
    refreshAfterLogin: vi.fn(async () => {}),
  });
  const persisted = await readConfigFileSnapshot();
  expect(persisted.valid).toBe(true);
  const profiles =
    agent === "main"
      ? loadPersistedSharedAuthProfileStore(state.env)?.profiles
      : loadPersistedAuthProfileStore(state.agentDir(agent))?.profiles;
  expect(profiles).toMatchObject({
    "openai:initial-proof": credential,
  });
  return { config: persisted.config, state };
}

// The real login owner writes credentials and config, then the chat-selection owner reads them.
// Only the provider's external sign-in is fixed; this does not prove account entitlement.
it.each([true, false])(
  "initializes a missing chat default after OAuth sign-in (credential-only: %s)",
  async (credentialOnly) => {
    const { config } = await loginFixture({ credentialOnly });
    expect(resolveDefaultModelForAgent({ cfg: config, agentId: "main" })).toEqual({
      provider: "openai",
      model: "gpt-6.1-sol",
    });
  },
);

it("initializes only the target agent while preserving its inherited fallback chain", async () => {
  const fallbacks = ["openai/gpt-6-luna"];
  const { config } = await loginFixture({ agent: "coder", defaults: { model: { fallbacks } } });
  expect(config.agents?.defaults?.model).toEqual({ fallbacks });
  expect(config.agents?.entries?.main?.model).toBeUndefined();
  expect(config.agents?.entries?.coder?.model).toEqual({
    primary: "openai/gpt-6.1-sol",
    fallbacks,
  });
  expect(resolveDefaultModelForAgent({ cfg: config, agentId: "coder" })).toEqual({
    provider: "openai",
    model: "gpt-6.1-sol",
  });
  expect(resolveAgentModelFallbacksOverride(config, "coder")).toEqual(fallbacks);
});

it.each(["global", "agent"] as const)(
  "preserves an explicit %s model, fallbacks and alias during OAuth sign-in",
  async (scope) => {
    const model = { primary: "chosen@openai:work", fallbacks: ["openai/gpt-6-luna"] };
    const defaults = { models: { "openai/gpt-6-astra": { alias: "chosen" } } };
    const { config } = await loginFixture({
      defaults: scope === "global" ? { ...defaults, model } : defaults,
      agentModel: scope === "agent" ? model : undefined,
    });
    expect(
      scope === "global" ? config.agents?.defaults?.model : config.agents?.entries?.main?.model,
    ).toEqual(model);
  },
);

it.each(["identity-only", "api-key"] as const)(
  "does not initialize a model for %s login",
  async (method) => {
    const { config } = await loginFixture({ method });
    expect(config.agents?.defaults?.model).toBeUndefined();
    expect(config.agents?.entries?.main?.model).toBeUndefined();
  },
);

it.each([
  ["existing-backend", "selected"],
  ["openai", "gpt-6-astra"],
] as const)("preserves configured %s/%s without an explicit primary", async (provider, model) => {
  const { config } = await loginFixture({
    models: {
      providers: {
        [provider]: {
          api: "openai-responses",
          baseUrl: "https://provider.example.test/v1",
          models: [
            {
              id: model,
              name: "Existing selection",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  });
  expect(resolveDefaultModelForAgent({ cfg: config, agentId: "main" })).toEqual({
    provider,
    model,
  });
  expect(config.agents?.defaults?.model).toBeUndefined();
});
