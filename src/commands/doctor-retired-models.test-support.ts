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

const retirementRules = vi.hoisted(() =>
  [
    "gpt-5.4",
    "retired-with-successor",
    "retired-without-successor",
    "retired-with-slash",
    "retired-chain-to-retired",
    "retired-incompat-chain",
    "retired-global-parent",
    "retired-runtime-parent",
    "retired-route-child",
    "retired-global-without-successor",
    "retired-api-conditioned",
  ].map((model) => ({
    provider: "openai",
    model,
    when:
      model === "retired-global-without-successor" ||
      model === "retired-global-parent" ||
      model === "retired-runtime-parent"
        ? undefined
        : {
            baseUrlHosts: ["chatgpt.com"],
            ...(model === "retired-api-conditioned"
              ? { providerConfigApiIn: ["openai-chatgpt-responses"] }
              : {}),
          },
    retirement: model.includes("without-successor")
      ? {}
      : {
          replacedBy:
            model === "retired-with-slash"
              ? "family/current-model"
              : model === "retired-chain-to-retired"
                ? "retired-without-successor"
                : model === "retired-incompat-chain"
                  ? "CHAT-LATEST"
                  : model === "retired-global-parent"
                    ? "retired-route-child"
                    : model === "retired-runtime-parent"
                      ? "gpt-5.5"
                      : "current-model",
        },
  })),
);

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
      return {
        ...snapshot,
        plugins,
      };
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
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
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

export async function createRetiredModelFixture(auth: "oauth" | "api-key" = "oauth") {
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
