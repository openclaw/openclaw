import { describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  dualRoutes,
  platformRoute,
  routeResolverFactory,
  subscriptionRoute,
} from "../../agents/model-auth-availability.test-support.js";
import { resolveSelectedModelCredential } from "../../agents/model-auth-selected-credential.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { createPreparedAccountCatalogAccess } from "../../agents/prepared-model-runtime.catalog-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { prepareModelsListResult } from "./models-list-result.js";
import {
  createModelsListTestContext,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

describe("models.list account service tiers", () => {
  it.each(["profile", "direct"] as const)(
    "publishes %s API-key embedded tiers without discovery and withdraws a downgraded tier",
    async (source) => {
      const model = {
        id: "synthetic-api-model",
        name: "Synthetic API model",
        provider: "openai",
        ...platformRoute,
      };
      const profileId = source === "profile" ? "openai:api-fixture" : undefined;
      const credential = { type: "api_key" as const, provider: "openai", key: "synthetic-api-key" };
      const context = createModelsListTestContext({
        cfg: {
          ...(source === "direct"
            ? {
                models: {
                  providers: {
                    openai: {
                      ...platformRoute,
                      auth: "api-key" as const,
                      apiKey: "synthetic-api-key",
                      models: [],
                    },
                  },
                },
              }
            : {}),
          agents: {
            defaults: {
              model: "openai/synthetic-api-model",
              models: { "openai/synthetic-api-model": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
        catalog: [model],
        preparedAuthStore: { version: 1, profiles: profileId ? { [profileId]: credential } : {} },
      });
      const initial = await readPreparedCatalog(context, "main");
      if (!initial) {
        throw new Error("Missing prepared fixture");
      }
      const accountCatalog = createPreparedAccountCatalogAccess(
        () => true,
        undefined,
        initial.config,
      );
      const owner = { ...initial, accountCatalog };
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        readPrepared: async () => owner,
        loadDeferred: async () => owner,
      });
      const prepare = () =>
        prepareModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: { view: "all", preparedOnly: true, includeDefaultModels: false },
          routeResolverFactory: routeResolverFactory(dualRoutes),
        });
      const first = await prepare();
      expect(first.read().models.find((row) => row.id === model.id)).toMatchObject({
        available: true,
        serviceTiers: ["priority", "ultrafast"],
      });
      const selectedCredential = resolveSelectedModelCredential({
        provider: "openai",
        profileId,
        mode: "api-key",
      });
      if (!selectedCredential) {
        throw new Error("Missing selected fixture credential");
      }
      accountCatalog.prepareServiceTierObserver({
        selectedCredential,
        credential,
      })({
        modelId: model.id,
        runtimeId: "openclaw",
        api: platformRoute.api,
        baseUrl: platformRoute.baseUrl,
        serviceTiers: ["priority"],
      });
      const next = await prepare();
      expect(next.read().models.find((row) => row.id === model.id)?.serviceTiers).toEqual([
        "priority",
      ]);
      expect(first.read().models.find((row) => row.id === model.id)?.serviceTiers).toEqual([
        "priority",
      ]);
    },
  );
  it.each(["codex", "openclaw"] as const)(
    "filters Codex tiers with %s selected while retaining account scope",
    async (selectedRuntime) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "model-tiers-",
          agentEnv: "main",
          env: WITHOUT_OPENAI_ENV_AUTH,
        },
        async (state) => {
          const model: ModelCatalogEntry = {
            id: "synthetic-tier-model",
            name: "Synthetic tier model",
            provider: "openai",
            api: subscriptionRoute.api,
            baseUrl: subscriptionRoute.baseUrl,
          };
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: "openai/synthetic-tier-model",
                models: {
                  "openai/synthetic-tier-model": {
                    agentRuntime: { id: selectedRuntime },
                    pickerRuntimes: ["codex", "openclaw"],
                  },
                },
              },
            },
          };
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
          const filterModelServiceTiers = vi.fn<
            NonNullable<AgentHarness["filterModelServiceTiers"]>
          >(({ serviceTiers }) => filteredTiers ?? serviceTiers);
          registry.agentHarnesses.push({
            pluginId: "codex",
            source: "test",
            harness: {
              id: "codex",
              label: "Codex",
              supports: () => ({ supported: true }),
              runAttempt: vi.fn(),
              filterModelServiceTiers,
            },
          });
          const discover = vi.fn(
            async (
              ctx: import("../../plugins/provider-catalog.types.js").ProviderCatalogContext,
            ) => {
              const auth = ctx.resolveProviderAuth("openai");
              return {
                provider: { baseUrl: subscriptionRoute.baseUrl, models: [] },
                outcomes: [
                  {
                    provider: "openai",
                    profileId: auth.profileId,
                    status: "ready" as const,
                    modelServiceTiers: [
                      {
                        modelId: model.id,
                        runtimeId: "codex",
                        api: subscriptionRoute.api,
                        baseUrl: subscriptionRoute.baseUrl,
                        serviceTiers: auth.profileId === accountA ? ["priority", "ultrafast"] : [],
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
          const initial = await readPreparedCatalog(context, "main");
          if (!initial) {
            throw new Error("Missing prepared fixture");
          }
          let current = true;
          const owner = {
            ...initial,
            isCurrent: () => current,
            accountCatalog: createPreparedAccountCatalogAccess(() => current),
          };
          registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
            readPrepared: async () => owner,
            loadDeferred: async () => owner,
          });
          const prepare = (profile: string, preparedOnly = false, refresh = false) =>
            prepareModelsListResult({
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
              routeResolverFactory: routeResolverFactory(dualRoutes),
            });
          const a = await prepare(accountA);
          const readRuntime = (result: typeof a, runtimeId: string) => {
            const row = result.read().models.find((entry) => entry.id === model.id);
            return row?.agentRuntime?.id === runtimeId
              ? row
              : row?.runtimeChoices?.find((choice) => choice.agentRuntime.id === runtimeId);
          };
          const selected = a.read().models.find((row) => row.id === model.id);
          expect(selected).toMatchObject({
            available: true,
            agentRuntime: { id: selectedRuntime },
          });
          expect(readRuntime(a, "codex")).toMatchObject({
            available: true,
            serviceTiers: ["priority", "ultrafast"],
            agentRuntime: { id: "codex" },
          });
          expect(filterModelServiceTiers).toHaveBeenCalledWith({
            config: cfg,
            agentId: "main",
            provider: model.provider,
            modelId: model.id,
            serviceTiers: ["priority", "ultrafast"],
          });
          filteredTiers = ["priority"];
          expect(readRuntime(a, "codex")?.serviceTiers).toEqual(["priority"]);
          expect(readRuntime(a, "openclaw")).not.toHaveProperty("serviceTiers");
          filteredTiers = ["priority", "ultrafast", "unadvertised-tier"];
          expect(readRuntime(a, "codex")?.serviceTiers).toEqual(["priority", "ultrafast"]);
          filteredTiers = undefined;
          expect(a.read().providerOutcomes).toEqual([
            { provider: "openai", profileId: accountA, status: "ready" },
          ]);
          const repeated = await prepare(accountA);
          expect(readRuntime(repeated, "codex")?.serviceTiers).toEqual(["priority", "ultrafast"]);
          expect(discover).toHaveBeenCalledOnce();
          const b = await prepare(accountB);
          expect(readRuntime(b, "codex")?.serviceTiers).toEqual([]);
          expect(discover).toHaveBeenCalledTimes(2);
          const preparedOnly = await prepare(accountA, true);
          expect(readRuntime(preparedOnly, "codex")?.serviceTiers).toEqual([
            "priority",
            "ultrafast",
          ]);
          expect(discover).toHaveBeenCalledTimes(2);
          await prepare(accountA, false, true);
          expect(discover).toHaveBeenCalledTimes(3);
          expect(a.isCurrent()).toBe(false);
          current = false;
          expect(readRuntime(a, "codex")).not.toHaveProperty("serviceTiers");
        },
      );
    },
  );
});
