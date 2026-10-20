import path from "node:path";
import { afterEach, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState as createState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const retirementRules = vi.hoisted(() =>
  (
    [
      ["gpt-5.4", "current-model", "route"],
      ["retired-with-successor", "current-model", "route"],
      ["retired-without-successor", undefined, "route"],
      ["retired-with-slash", "family/current-model", "route"],
      ["retired-chain-to-retired", "retired-without-successor", "route"],
      ["retired-incompat-chain", "CHAT-LATEST", "route"],
      ["retired-global-parent", "retired-route-child", "global"],
      ["retired-runtime-parent", "gpt-5.5", "global"],
      ["retired-route-child", "current-model", "route"],
      ["retired-global-without-successor", undefined, "global"],
      ["retired-api-conditioned", "current-model", "api"],
    ] as const
  ).map(([model, replacedBy, scope]) => ({
    provider: "openai",
    model,
    when:
      scope === "global"
        ? undefined
        : {
            baseUrlHosts: ["chatgpt.com"],
            ...(scope === "api" ? { providerConfigApiIn: ["openai-chatgpt-responses"] } : {}),
          },
    retirement: replacedBy === undefined ? {} : { replacedBy },
  })),
);

vi.mock(import("../plugins/manifest-contract-eligibility.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadManifestMetadataSnapshot(
      params: Parameters<typeof actual.loadManifestMetadataSnapshot>[0],
    ) {
      const snapshot = actual.loadManifestMetadataSnapshot(params);
      const plugins: Array<(typeof snapshot.plugins)[number]> = [];
      for (const plugin of snapshot.plugins) {
        plugins.push(
          plugin.id === "openai"
            ? { ...plugin, modelCatalog: { ...plugin.modelCatalog, suppressions: retirementRules } }
            : plugin,
        );
      }
      return { ...snapshot, plugins };
    },
  };
});

vi.mock(import("../agents/openai-model-routes.js"), async (importOriginal) => {
  const actual = await importOriginal();
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
  const state = await createState({ layout: "state-only", prefix: "doctor-retired-model-" });
  states.push(state);
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
  const { state, cfg } = await createRetiredModelFixture();
  vi.stubEnv("XAI_API_KEY", undefined);
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "xai:fixture": { provider: "xai", type: "api_key", key: "synthetic-xai-key" },
    },
  });
  cfg.agents!.defaults = {
    workspace: state.workspaceDir,
    model: { primary: "Grok", fallbacks: ["xai/grok-4.3"] },
    models: { "xai/auto": { alias: "Grok", params: { temperature: 0.25 } } },
    modelPolicy: { allow: ["xai/auto", "xai/grok-4.3"] },
  };
  cfg.auth = { order: { xai: ["xai:fixture"] } };
  cfg.models!.providers = {
    xai: {
      baseUrl: "https://api.x.ai/v1",
      api: "openai-responses",
      auth: "api-key",
      models: [],
    },
  };
  cfg.plugins = { allow: ["xai"], entries: { xai: { enabled: true } } };
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
