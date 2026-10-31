import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  dualRoutes,
  platformRoute,
  routeResolverFactory,
  mockRouteResolverFactory,
  subscriptionRoute,
} from "../../agents/model-auth-availability.test-support.js";
import { resolveSelectedModelCredential } from "../../agents/model-auth-selected-credential.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createPreparedAccountCatalogAccess } from "../../agents/prepared-model-runtime.catalog-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "../test-helpers.env.js";
import { buildModelsListResult, prepareModelsListResult } from "./models-list-result.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

afterEach(() => vi.useRealTimers());

const advertisedTiers = ["priority", "ultrafast"];
const subscriptionFields = { api: subscriptionRoute.api, baseUrl: subscriptionRoute.baseUrl };
const apiCredential = { type: "api_key" as const, provider: "openai", key: "synthetic-api-key" };
type PreparedResult = Awaited<ReturnType<typeof prepareModelsListResult>>;
const readModel = (result: PreparedResult, id: string) =>
  result.read().models.find((row) => row.id === id);
const tierObservation = (requestedTier: string, responseTier: string) => ({
  requestedTier,
  responseTier,
});
const catalogModel = (
  id: string,
  route: Pick<ModelCatalogEntry, "api" | "baseUrl"> = platformRoute,
): ModelCatalogEntry => ({ id, name: id, provider: "openai", ...route });

function modelConfig(
  ids: string[],
  runtime = "openclaw",
  pickerRuntimes?: string[],
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "openai/" + ids[0],
        models: Object.fromEntries(
          ids.map((id) => ["openai/" + id, { agentRuntime: { id: runtime }, pickerRuntimes }]),
        ),
      },
    },
  };
}

async function installAccountCatalog(
  context: ReturnType<typeof createModelsListTestContext>,
  isCurrent = () => true,
  includeConfig = false,
) {
  const initial = expectDefined(await readPreparedCatalog(context, "main"), "prepared fixture");
  const accountCatalog = createPreparedAccountCatalogAccess(
    isCurrent,
    undefined,
    includeConfig ? initial.config : undefined,
  );
  const owner = { ...initial, isCurrent, accountCatalog };
  registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
    readPrepared: async () => owner,
    loadDeferred: async () => owner,
  });
  return accountCatalog;
}

function preparePublic(context: ReturnType<typeof createModelsListTestContext>) {
  mockRouteResolverFactory(routeResolverFactory(dualRoutes));
  return prepareModelsListResult({
    source: { kind: "gateway", context },
    agentId: "main",
    params: { view: "all", preparedOnly: true, includeDefaultModels: false },
  });
}

it.each(["profile", "direct"] as const)(
  "keeps %s API-key tiers selectable and projects transient fulfillment without discovery",
  async (source) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const model = catalogModel("synthetic-api-model");
    const profileId = source === "profile" ? "openai:api-fixture" : undefined;
    const cfg = modelConfig([model.id]);
    if (source === "direct") {
      cfg.models = {
        providers: {
          openai: {
            ...platformRoute,
            auth: "api-key",
            apiKey: apiCredential.key,
            models: [],
          },
        },
      };
    }
    const context = createModelsListTestContext({
      cfg,
      catalog: [model],
      preparedAuthStore: { version: 1, profiles: profileId ? { [profileId]: apiCredential } : {} },
    });
    const accountCatalog = await installAccountCatalog(context, () => true, true);
    const first = await preparePublic(context);
    const read = (result = first) => readModel(result, model.id);
    expect(read()).toMatchObject({
      available: true,
      serviceTiers: advertisedTiers,
    });
    const selectedCredential = expectDefined(
      resolveSelectedModelCredential({ provider: "openai", profileId, mode: "api-key" }),
      "Missing selected fixture credential",
    );
    const record = accountCatalog.prepareServiceTierObserver({
      selectedCredential,
      credential: apiCredential,
    });
    const route = {
      modelId: model.id,
      runtimeId: "openclaw",
      api: platformRoute.api,
      baseUrl: platformRoute.baseUrl,
    };
    const observe = (value: ReturnType<typeof tierObservation>) => record({ ...route, ...value });
    const ultrafast = tierObservation("ultrafast", "priority");
    const priority = tierObservation("priority", "fast");
    const observations = [priority, ultrafast];
    observe(ultrafast);
    observe(priority);
    for (const projection of [first, await preparePublic(context)]) {
      expect(read(projection)).toMatchObject({
        serviceTiers: advertisedTiers,
        supportsServiceTierRecovery: true,
        serviceTierObservation: priority,
        serviceTierObservations: observations,
      });
    }
    observe(ultrafast);
    expect(read()).toMatchObject({
      serviceTierObservation: ultrafast,
      serviceTierObservations: observations,
    });
    observe(tierObservation("ultrafast", "ultrafast"));
    observe(tierObservation("priority", "priority"));
    expect(read()).toMatchObject({
      serviceTiers: advertisedTiers,
      serviceTierObservations: observations,
    });
    vi.setSystemTime(Date.now() + 60_000);
    expect(read()).not.toHaveProperty("serviceTierObservation");
    expect(read()).not.toHaveProperty("serviceTierObservations");
    expect(read()).toMatchObject({ serviceTiers: advertisedTiers });
  },
);
it.for(["codex", "openclaw"] as const)(
  "filters Codex tiers with %s selected while retaining account scope",
  async (selectedRuntime, { signal }) =>
    withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "model-tiers-",
        agentEnv: "main",
        env: WITHOUT_OPENAI_ENV_AUTH,
      },
      async (state) => {
        const model = catalogModel("synthetic-tier-model", subscriptionFields);
        const cfg = modelConfig([model.id], selectedRuntime, ["codex", "openclaw"]);
        cfg.agents!.defaults!.workspace = state.workspaceDir;
        const human = ensureProfileForEmail("tier-owner@example.test");
        const connectAccount = (token: string) =>
          connectUserModelAccount({
            ownerProfileId: human.id,
            credential: { type: "token", provider: "openai", token },
            assertCurrent: () => {},
          }).authProfileId;
        const accountA = connectAccount("synthetic-account-a");
        const accountB = connectAccount("synthetic-account-b");
        const registry = createEmptyPluginRegistry();
        let filteredTiers: readonly string[] | undefined;
        registry.agentHarnesses.push({
          pluginId: "codex",
          source: "test",
          harness: {
            id: "codex",
            label: "Codex",
            supports: () => ({ supported: true }),
            runAttempt: vi.fn(),
            filterModelServiceTiers: ({ serviceTiers }) => filteredTiers ?? serviceTiers,
          },
        });
        const discover = vi.fn(
          async (ctx: import("../../plugins/provider-catalog.types.js").ProviderCatalogContext) => {
            const { profileId } = ctx.resolveProviderAuth("openai");
            return {
              provider: { baseUrl: subscriptionRoute.baseUrl, models: [] },
              outcomes: [
                {
                  provider: "openai",
                  profileId,
                  status: "ready" as const,
                  modelServiceTiers: [
                    {
                      modelId: model.id,
                      runtimeId: "codex",
                      ...subscriptionFields,
                      serviceTiers: profileId === accountA ? [...advertisedTiers] : [],
                    },
                  ],
                },
              ],
            };
          },
        );
        registry.providers.push({
          pluginId: "openai",
          source: "test",
          provider: { id: "openai", label: "OpenAI", auth: [], catalog: { run: discover } },
        });
        const context = createModelsListTestContext({
          cfg,
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          catalog: [model],
          pluginRegistry: registry,
        });
        let current = true;
        await installAccountCatalog(context, () => current);
        const requestParams = (
          profile: string,
          preparedOnly = false,
          refresh = false,
        ): Parameters<typeof prepareModelsListResult>[0] => ({
          source: { kind: "gateway", context },
          agentId: "main",
          params: { view: "all", preparedOnly, ...(refresh ? { refresh: true } : {}) },
          readScope: {
            agentId: "main",
            sessionKey: "agent:main:tiers",
            sessionEntry: {
              authProfileOverride: profile,
              authProfileOverrideSource: "user",
              providerOverride: "openai",
              modelOverride: model.id,
            },
          },
        });
        const prepare = (profile: string, preparedOnly = false, refresh = false) => {
          mockRouteResolverFactory(routeResolverFactory(dualRoutes));
          return prepareModelsListResult(requestParams(profile, preparedOnly, refresh));
        };
        const a = await prepare(accountA, false, true);
        const readRuntime = (result: typeof a, runtimeId: string) => {
          const row = readModel(result, model.id);
          return row?.agentRuntime?.id === runtimeId
            ? row
            : row?.runtimeChoices?.find((choice) => choice.agentRuntime.id === runtimeId);
        };
        expect(readModel(a, model.id)).toMatchObject({
          available: true,
          agentRuntime: { id: selectedRuntime },
        });
        expect(readRuntime(a, "codex")).toMatchObject({
          available: true,
          serviceTiers: advertisedTiers,
          agentRuntime: { id: "codex" },
        });
        filteredTiers = ["priority"];
        expect(readRuntime(a, "codex")?.serviceTiers).toEqual(["priority"]);
        expect(readRuntime(a, "openclaw")).not.toHaveProperty("serviceTiers");
        filteredTiers = ["priority", "ultrafast", "unadvertised-tier"];
        expect(readRuntime(a, "codex")?.serviceTiers).toEqual(advertisedTiers);
        filteredTiers = undefined;
        expect(a.read().providerOutcomes).toEqual([
          { provider: "openai", profileId: accountA, status: "ready" },
        ]);
        const expectTiers = (result: typeof a, tiers = advertisedTiers) =>
          expect(readRuntime(result, "codex")?.serviceTiers).toEqual(tiers);
        expectTiers(await prepare(accountA));
        expect(discover).toHaveBeenCalledOnce();
        expectTiers(await prepare(accountB, false, true), []);
        expect(discover).toHaveBeenCalledTimes(2);
        expectTiers(await prepare(accountA, true));
        expect(discover).toHaveBeenCalledTimes(2);
        const entered = createDeferred();
        const release = createDeferred();
        const discoverAccount = discover.getMockImplementation()!;
        discover.mockImplementationOnce(async (ctx) => {
          entered.resolve();
          await release.promise;
          return discoverAccount(ctx);
        });
        const refreshing = prepare(accountA, false, true);
        try {
          await withinTest(entered.promise, signal);
          expectTiers(await prepare(accountA, true));
          expectTiers(await withinTest(prepare(accountA), signal));
          expect(a.isCurrent()).toBe(true);
          expectTiers(await prepare(accountB), []);
        } finally {
          release.resolve();
          await refreshing;
        }
        expect(discover).toHaveBeenCalledTimes(3);
        expect(a.isCurrent()).toBe(false);
        current = false;
        // Descriptive rows may survive retirement, but cannot carry tiers or publish a result.
        expect(readRuntime(a, "codex")?.serviceTiers).toBeUndefined();
        expect(readRuntime(a, "openclaw")?.serviceTiers).toBeUndefined();
        await expect(buildModelsListResult(requestParams(accountA, true))).rejects.toThrow(
          PreparedModelRuntimePublicationSupersededError,
        );
        expect(discover).toHaveBeenCalledTimes(3);
      },
    ),
);

it("publishes provider tier restrictions through the model catalog projection", async () => {
  const ids = ["synthetic-priority-model", "synthetic-default-model"];
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: "openai",
    source: "test",
    provider: {
      id: "openai",
      label: "OpenAI",
      auth: [],
      resolveFastModeSupport: ({ modelId }) => modelId === ids[0],
      resolveServiceTiers: ({ modelId }) =>
        modelId === ids[0] ? ["default", "priority"] : ["default"],
    },
  });
  const context = createModelsListTestContext({
    pluginRegistry,
    cfg: modelConfig(ids),
    catalog: ids.map((id) => catalogModel(id)),
    preparedAuthStore: { version: 1, profiles: { "openai:policy-fixture": apiCredential } },
  });
  const result = await preparePublic(context);
  const models = result.read().models;
  for (const [index, supportsFastMode, serviceTiers] of [
    [0, true, ["default", "priority"]],
    [1, false, ["default"]],
  ] as const) {
    expect(models.find((row) => row.id === ids[index])).toMatchObject({
      available: true,
      supportsServiceTierRecovery: true,
      supportsFastMode,
      serviceTiers,
    });
  }
});

it("asks speed policy about the implicit OpenClaw runtime a row will use", async () => {
  const provider = "example-router";
  const ids = ["synthetic-priority-route", "synthetic-standard-route"];
  const pluginRegistry = createEmptyPluginRegistry();
  // Bundled speed policies answer only for the runtime that maps the request.
  pluginRegistry.providers.push({
    pluginId: provider,
    source: "test",
    provider: {
      id: provider,
      label: "Example router",
      auth: [],
      resolveFastModeSupport: ({ modelId, runtimeId }) =>
        runtimeId === "openclaw" ? modelId === ids[0] : undefined,
    },
  });
  const context = createModelsListTestContext({
    pluginRegistry,
    cfg: { agents: { defaults: { model: `${provider}/${ids[0]}` } } },
    catalog: ids.map((id) => providerCatalogEntry(provider, id)),
    preparedAuthStore: {
      version: 1,
      profiles: {
        [`${provider}:fixture`]: { type: "api_key", provider, key: "synthetic-api-key" },
      },
    },
  });
  const models = (await preparePublic(context)).read().models;
  for (const [index, supportsFastMode] of [
    [0, true],
    [1, false],
  ] as const) {
    const row = models.find((candidate) => candidate.id === ids[index]);
    expect(row?.agentRuntime).toBeUndefined();
    expect(row?.supportsFastMode).toBe(supportsFastMode);
  }
});
