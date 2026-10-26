import { expect, it } from "vitest";
import {
  dualRoutes,
  platformRoute,
  routeResolverFactory,
  subscriptionRoute,
} from "../../agents/model-auth-availability.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listModels,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

it("publishes only explicit access metadata for the selected account, model and runtime", async () => {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "access-catalog-",
      agentEnv: "main",
      env: WITHOUT_OPENAI_ENV_AUTH,
    },
    async (state) => {
      const id = "synthetic-access-model";
      const catalog = [{ id, name: id, provider: "openai", ...subscriptionRoute }];
      const profiles = {
        "openai:a": { type: "token" as const, provider: "openai", token: "synthetic-a" },
        "openai:b": { type: "token" as const, provider: "openai", token: "synthetic-b" },
      };
      const read = async (account: string, runtime = "openclaw") => {
        const result = await listModels({
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          cfg: {
            auth: { order: { openai: [account] } },
            agents: {
              defaults: {
                model: "openai/" + id,
                models: { ["openai/" + id]: { agentRuntime: { id: runtime } } },
              },
            },
          },
          catalog,
          preparedOnly: true,
          includeDefaultModels: false,
          preparedAuthStore: { version: 1, profiles },
          routeResolverFactory: routeResolverFactory(dualRoutes),
          catalogDiagnostics: {
            providerOutcomes: [
              {
                provider: "openai",
                profileId: "openai:a",
                status: "ready",
                modelAccessPrograms: [
                  {
                    modelId: id,
                    runtimeId: "openclaw",
                    api: subscriptionRoute.api,
                    baseUrl: subscriptionRoute.baseUrl,
                    cyber: ["standard", "daybreak_blue"],
                  },
                ],
              },
            ],
          },
        });
        return result.models.find((model) => model.id === id);
      };
      expect(await read("openai:a")).toMatchObject({
        availableAccessPrograms: { cyber: ["standard", "daybreak_blue"] },
      });
      expect(await read("openai:b")).not.toHaveProperty("availableAccessPrograms");
      expect(await read("openai:a", "codex")).not.toHaveProperty("availableAccessPrograms");
    },
  );
});

it("publishes configured-key access without borrowing a saved account's grants", async () => {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "direct-access-catalog-",
      agentEnv: "main",
      env: WITHOUT_OPENAI_ENV_AUTH,
    },
    async (state) => {
      const id = "synthetic-access-model";
      const read = async (profileId?: string) =>
        listModels({
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          cfg: {
            agents: {
              defaults: {
                model: "openai/" + id,
                models: { ["openai/" + id]: { agentRuntime: { id: "openclaw" } } },
              },
            },
            models: {
              providers: {
                openai: {
                  ...platformRoute,
                  auth: "api-key",
                  apiKey: "synthetic-direct",
                  models: [],
                },
              },
            },
          },
          catalog: [{ id, name: id, provider: "openai", ...platformRoute }],
          preparedOnly: true,
          includeDefaultModels: false,
          preparedAuthStore: { version: 1, profiles: {} },
          routeResolverFactory: routeResolverFactory(dualRoutes),
          catalogDiagnostics: {
            providerOutcomes: [
              {
                provider: "openai",
                profileId,
                status: "ready",
                modelAccessPrograms: [
                  {
                    modelId: id,
                    runtimeId: "openclaw",
                    api: platformRoute.api,
                    baseUrl: platformRoute.baseUrl,
                    cyber: ["standard", "daybreak_blue"],
                  },
                ],
              },
            ],
          },
        });
      expect((await read()).models.find((model) => model.id === id)).toMatchObject({
        availableAccessPrograms: { cyber: ["standard", "daybreak_blue"] },
      });
      expect(
        (await read("openai:other")).models.find((model) => model.id === id),
      ).not.toHaveProperty("availableAccessPrograms");
    },
  );
});
