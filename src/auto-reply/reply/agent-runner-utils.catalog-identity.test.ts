// Preserve the catalog fixture before loading its runtime consumers.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreparedModelCatalogConfigReplacedError } from "../../agents/prepared-model-catalog.errors.js";
import { loadPreparedModelCatalogSnapshot } from "../../agents/prepared-model-catalog.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../agents/prepared-model-runtime.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  resolveQueuedReplyExecutionConfig,
  resolveQueuedReplyRuntimeConfig,
} from "./agent-runner-utils.js";

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: () => ({
    config: getRuntimeConfigSnapshot(),
    sourceConfig: getRuntimeConfigSourceSnapshot(),
    configRefsPrepared: true,
  }),
}));
vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: OpenClawConfig }) => ({
    resolvedConfig: { ...config, skills: { entries: { example: { apiKey: "command-key" } } } },
  }),
}));
vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set(["skills.entries.*.apiKey"]),
  getAgentRuntimeOptionalCommandSecretPaths: () => new Set(),
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set() }),
}));

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "queued-reply-catalog-identity" });
  await resetPreparedModelRuntimeHarness(state);
  getPreparedModelRuntimeMocks().configuredAgentIds = ["main"];
});
afterEach(async () => {
  clearRuntimeConfigSnapshot();
  await resetPreparedModelRuntimeHarness(state);
});

const source: OpenClawConfig = {
  skills: {
    entries: {
      example: { apiKey: { source: "env", provider: "default", id: "EXAMPLE_API_KEY" } },
    },
  },
};
const catalogParams = { agentId: "main", readOnly: true };

async function publish(config: OpenClawConfig, sourceConfig = source) {
  setRuntimeConfigSnapshot(config, sourceConfig);
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  return config;
}

describe("queued reply catalog identity", () => {
  it("keeps repeated queued replies on the exact config of the published catalog", async () => {
    const runtime = await publish({
      skills: { entries: { example: { apiKey: "activated-key" } } },
    });
    const catalog = await loadPreparedModelCatalogSnapshot({ ...catalogParams, config: runtime });
    for (const queuedConfig of [source, runtime, structuredClone(source)]) {
      const resolved = await resolveQueuedReplyExecutionConfig(queuedConfig, {
        messageProvider: "discord",
      });
      expect(JSON.stringify(resolved)).toBe(JSON.stringify(runtime));
      await expect(
        loadPreparedModelCatalogSnapshot({ ...catalogParams, config: resolved }),
      ).resolves.toBe(catalog);
    }
  });

  it("keeps an admitted turn's retained config when a newer generation publishes", async () => {
    const queuedConfig = await publish({
      skills: { entries: { example: { apiKey: "first-key" } } },
    });
    const next = await publish(
      {
        skills: { entries: { example: { apiKey: "rotated-key" } } },
        tools: { updatePlan: true },
      },
      { ...source, tools: { updatePlan: true } },
    );
    // Outside any admitted generation scope (a queue drain), the rebind adopts the
    // replacement; inside one (an already-admitted immediate reply), the retained
    // config stays paired with its generation lease.
    expect(resolveQueuedReplyRuntimeConfig(queuedConfig)).toBe(next);
    const admittedGeneration = {
      pluginMetadataSnapshot: {},
      inlineProviderModels: [],
      configuredCatalogEntries: [],
    } as unknown as PreparedModelRuntimePluginGeneration;
    const resolved = withPreparedModelRuntimePluginGenerationScope(admittedGeneration, () =>
      resolveQueuedReplyRuntimeConfig(queuedConfig),
    );
    expect(resolved).toBe(queuedConfig);
  });

  it("adopts a re-prepared config and secret generation without accepting genuine divergence", async () => {
    const queuedConfig = await publish({
      skills: { entries: { example: { apiKey: "first-key" } } },
    });
    const next = await publish(
      {
        skills: { entries: { example: { apiKey: "rotated-key" } } },
        tools: { updatePlan: true },
      },
      { ...source, tools: { updatePlan: true } },
    );
    const resolved = await resolveQueuedReplyExecutionConfig(queuedConfig);
    expect(resolved).toBe(next);
    await expect(
      loadPreparedModelCatalogSnapshot({ ...catalogParams, config: resolved }),
    ).resolves.toBeDefined();
    await expect(
      loadPreparedModelCatalogSnapshot({
        ...catalogParams,
        config: { ...resolved, skills: { entries: { example: { apiKey: "divergent-key" } } } },
      }),
    ).rejects.toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
  });
});
