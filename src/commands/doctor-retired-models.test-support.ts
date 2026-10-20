import path from "node:path";
import { afterEach, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const retirementRules = vi.hoisted(() => {
  const successors = {
    "gpt-5.4": "current-model",
    "retired-with-successor": "current-model",
    "retired-without-successor": undefined,
    "retired-with-slash": "family/current-model",
    "retired-chain-to-retired": "retired-without-successor",
    "retired-incompat-chain": "CHAT-LATEST",
    "retired-global-parent": "retired-route-child",
    "retired-runtime-parent": "gpt-5.5",
    "retired-route-child": "current-model",
    "retired-global-without-successor": undefined,
    "retired-api-conditioned": "current-model",
  };
  const global = new Set([
    "retired-global-without-successor",
    "retired-global-parent",
    "retired-runtime-parent",
  ]);
  return Object.entries(successors).map(([model, replacedBy]) => ({
    provider: "openai",
    model,
    when: global.has(model)
      ? undefined
      : {
          baseUrlHosts: ["chatgpt.com"],
          ...(model === "retired-api-conditioned"
            ? { providerConfigApiIn: ["openai-chatgpt-responses"] }
            : {}),
        },
    retirement: replacedBy === undefined ? {} : { replacedBy },
  }));
});

vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>();
  return {
    ...actual,
    loadManifestMetadataSnapshot: (
      ...args: Parameters<typeof actual.loadManifestMetadataSnapshot>
    ) => {
      const snapshot = actual.loadManifestMetadataSnapshot(...args);
      const plugins = snapshot.plugins.slice();
      for (const [index, plugin] of snapshot.plugins.entries()) {
        if (plugin.id === "openai") {
          plugins[index] = {
            ...plugin,
            modelCatalog: { ...plugin.modelCatalog, suppressions: retirementRules },
          };
        }
      }
      return { ...snapshot, plugins };
    },
  };
});

vi.mock("../agents/openai-model-routes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/openai-model-routes.js")>();
  return {
    ...actual,
    createOpenAIModelRoutesResolver: () => () => ({
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: (
        [
          ["openai-responses", "https://api.openai.com/v1", "api-key"],
          ["openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", "subscription"],
        ] as const
      ).map(([api, baseUrl, authRequirement]) => ({
        api,
        baseUrl,
        authRequirement,
        requestTransportOverrides: "none",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
      })),
    }),
  };
});

const states: OpenClawTestState[] = [];
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

export async function createRetiredModelFixture(
  auth: "oauth" | "api-key" = "oauth",
  cooldownUntil?: number,
) {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "doctor-retired-model-",
  });
  states.push(state);
  state.applyEnv();
  vi.stubEnv("OPENAI_API_KEY", undefined);
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      chatgpt: {
        provider: "openai",
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: 9_999_999_999_999,
      },
      platform: { provider: "openai", type: "api_key", key: "synthetic-key" },
    },
    ...(cooldownUntil === undefined ? {} : { usageStats: { chatgpt: { cooldownUntil } } }),
  });
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    auth: { order: { openai: [auth === "oauth" ? "chatgpt" : "platform"] } },
    models: { providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } } },
  };
  return { state, cfg };
}

export async function createNativeXaiRetirementFixture() {
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  const { state } = await createRetiredModelFixture();
  vi.stubEnv("XAI_API_KEY", undefined);
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "xai:fixture": { provider: "xai", type: "api_key", key: "synthetic-xai-key" },
    },
  });
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: {} },
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "Grok", fallbacks: ["xai/grok-4.3"] },
        models: { "xai/auto": { alias: "Grok", params: { temperature: 0.25 } } },
        modelPolicy: { allow: ["xai/auto", "xai/grok-4.3"] },
      },
    },
    auth: { order: { xai: ["xai:fixture"] } },
    models: {
      providers: {
        xai: {
          baseUrl: "https://api.x.ai/v1",
          api: "openai-responses",
          auth: "api-key",
          models: [],
        },
      },
    },
    plugins: { allow: ["xai"], entries: { xai: { enabled: true } } },
  };
  const { repairStaleAgentModelRefs } =
    await import("./doctor/shared/stale-agent-model-ref-repair.js");
  const repair = (config: OpenClawConfig) =>
    repairStaleAgentModelRefs(config, {
      env: state.env,
      pluginProviderIds: new Set(["xai"]),
      persistedProviderIdsByAgentId: new Map(),
    });
  return { cfg, state, repair };
}
