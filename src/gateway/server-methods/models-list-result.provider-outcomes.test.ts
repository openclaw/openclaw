import { expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import { createCatalogAttemptReporter } from "../../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { buildModelsListResult, prepareModelsListResult } from "./models-list-result.js";
import { createModelsListTestContext } from "./models-list-result.openai-routes.test-support.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture();
const modelConfig: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6-sol" },
      models: { "openai/*": {}, "openai/gpt-5.6-sol": {} },
    },
  },
};
const openaiModel = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai",
  api: "openai-responses" as const,
  baseUrl: "https://api.openai.com/v1",
};
function oauth(label: string): AuthProfileStore["profiles"][string] {
  return {
    type: "oauth",
    provider: "openai",
    access: `${label}-access-token`,
    refresh: `${label}-refresh-token`,
    expires: Date.now() + 30 * 60_000,
  };
}
const emptyAuthStore = { version: 1, profiles: {} } as const;
const authStore = (
  profiles: AuthProfileStore["profiles"],
  usageStats?: AuthProfileStore["usageStats"],
): AuthProfileStore => ({ version: 1, profiles, ...(usageStats ? { usageStats } : {}) });
const rejectedKey = { type: "api_key" as const, provider: "openai", key: "rejected-api-key" };
const rejected = (profileId: string) => ({
  provider: "openai",
  profileId,
  status: "auth-rejected" as const,
});
type DecisionOptions = Parameters<typeof createModelCatalogDecisions>[0];
function decisions(
  snapshot: DecisionOptions["snapshot"],
  preparedAuthStore: AuthProfileStore = emptyAuthStore,
  cfg = modelConfig,
  preferredProfileId?: string,
) {
  return createModelCatalogDecisions({
    cfg,
    agentId: "main",
    snapshot,
    metadataSnapshot,
    preparedAuthStore,
    preferredProfileId,
  });
}

function preloaded(
  config: OpenClawConfig,
  snapshot: Parameters<typeof createModelCatalogDecisions>[0]["snapshot"],
  catalogProjector: ReturnType<typeof createModelCatalogDecisions>,
  includeDefaultModels?: boolean,
) {
  return {
    source: {
      kind: "gateway" as const,
      context: createModelsListTestContext({
        cfg: config,
        catalog: [],
        preparedAuthStore: emptyAuthStore,
        metadataSnapshot,
      }),
    },
    params: { view: "configured" as const, includeDefaultModels },
    preloadedCatalog: { agentId: "main", config, snapshot },
    preloadedOnly: true,
    catalogProjector,
  };
}

it.each([false, true])("preserves rejection on refresh failure=%s", async (unavailable) => {
  const reporter = createCatalogAttemptReporter(
    {},
    { key: "synthetic", pluginFingerprint: "synthetic", credentials: {} },
    () => true,
    () => {},
  );
  const providerOutcomes = [
    rejected("openai:chatgpt"),
    ...(unavailable ? [{ provider: "unreachable", status: "unavailable" as const }] : []),
  ];
  const context = createModelsListTestContext({
    cfg: {},
    catalog: [],
    catalogComplete: true,
    preparedAuthStore: emptyAuthStore,
    metadataSnapshot,
    catalogDiagnostics: reporter.withRefreshStatus({
      entries: [],
      routeVariants: [],
      providerOutcomes,
    }),
  });

  await expect(
    buildModelsListResult({ source: { kind: "gateway", context }, params: { view: "all" } }),
  ).resolves.toEqual({
    models: [],
    providerOutcomes,
    ...(unavailable ? { refreshFailed: true } : {}),
  });
});

it.each([false, true])(
  "marks API-key rejection unavailable (catalog=%s)",
  async (catalogRejection) => {
    const config = { ...modelConfig, auth: { order: { openai: ["openai:chatgpt"] } } };
    const snapshot = markPreparedModelCatalogFull({
      entries: [openaiModel],
      routeVariants: [openaiModel],
      providerOutcomes: [
        {
          ...rejected("openai:chatgpt"),
          ...(catalogRejection ? { rejectionScope: "catalog" as const } : {}),
        },
      ],
    });
    const projector = decisions(
      snapshot,
      authStore(
        {
          "openai:chatgpt": rejectedKey,
          "openai:other": oauth("accepted"),
        },
        catalogRejection
          ? {
              "openai:chatgpt": {
                disabledUntil: 2_000_000_000_000,
                disabledReason: "auth_permanent",
              },
            }
          : undefined,
      ),
      config,
      "openai:chatgpt",
    );
    await expect(
      buildModelsListResult({ ...preloaded(config, snapshot, projector, false), agentId: "main" }),
    ).resolves.toEqual({
      models: [
        expect.objectContaining({
          id: "gpt-5.6-sol",
          available: false,
          unavailableReason: "auth-failed",
        }),
      ],
      providerOutcomes: [rejected("openai:chatgpt")],
    });
  },
);

it("does not apply one profile rejection to a different selected profile", () => {
  const subscriptionModel = {
    ...openaiModel,
    api: "openai-chatgpt-responses" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex",
  };
  const snapshot = {
    entries: [subscriptionModel],
    routeVariants: [subscriptionModel],
    providerOutcomes: [rejected("openai:rejected")],
  };
  const projector = decisions(
    snapshot,
    authStore({ "openai:rejected": oauth("rejected"), "openai:accepted": oauth("accepted") }),
    modelConfig,
    "openai:accepted",
  );

  expect(projector.evaluateEntry(subscriptionModel, [subscriptionModel])).toMatchObject({
    availability: true,
    selectedProfileId: "openai:accepted",
  });
});

it.each([false, true])("projects cooldown only when unavailable (%s)", async (available) => {
  const cooldown = {
    unavailableReason: "cooldown" as const,
    unavailableUntil: 2_000_000_000_000,
  };
  const config = {
    agents: { defaults: { models: { "custom/test-model": {} } } },
  } as OpenClawConfig;
  const model = { id: "test-model", name: "Test Model", provider: "custom" };
  const snapshot = markPreparedModelCatalogFull({ entries: [model], routeVariants: [model] });
  const projector = decisions(snapshot, emptyAuthStore, config);
  const evaluateEntry = vi.spyOn(projector, "evaluateEntry").mockReturnValue({
    availability: available,
    ...cooldown,
    routeResolution: null,
  });
  const evaluateNative = vi.spyOn(projector, "evaluateNative");
  const prepared = await prepareModelsListResult(preloaded(config, snapshot, projector));

  expect(prepared.read().models).toEqual([
    { ...model, tags: ["configured"], available, ...(available ? {} : cooldown) },
  ]);
  const hostEvaluations = evaluateEntry.mock.calls.length;
  evaluateNative.mockReturnValue({ availability: true, routeResolution: null });
  expect(prepared.read().models).toEqual([{ ...model, tags: ["configured"], available: true }]);
  evaluateNative.mockReturnValue({ availability: false, routeResolution: null });
  expect(prepared.read().models).toEqual([{ ...model, tags: ["configured"], available: false }]);
  expect(evaluateEntry).toHaveBeenCalledTimes(hostEvaluations);
});
