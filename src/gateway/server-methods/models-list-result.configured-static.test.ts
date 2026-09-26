import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelsListResultSchema,
  type ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { requestModelsList } from "./models-list-request.test-support.js";
import {
  catalogEntry,
  createModelsListTestContext,
  listModels,
  providerCatalogEntry,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

describe("models.list configured static entries", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    { name: "automatic", utilityModel: undefined, defaultUtilityModel: "small" },
    { name: "explicit", utilityModel: "custom/explicit", defaultUtilityModel: "small" },
    { name: "disabled", utilityModel: "", defaultUtilityModel: "small" },
    { name: "no provider default", utilityModel: undefined, defaultUtilityModel: undefined },
  ])(
    "previews global automatic utility routing with $name configuration",
    async ({ utilityModel, defaultUtilityModel }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "global-utility-catalog-" },
        async (state) => {
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                model: "global-primary@work",
                models: { "custom/primary": { alias: "global-primary" } },
                utilityModel,
              },
              entries: {
                worker: {
                  model: "other/primary@personal",
                  utilityModel: "other/explicit",
                  models: { "other/primary": { alias: "global-primary" } },
                },
              },
            },
          };
          const metadataSnapshot = createPluginMetadataSnapshotFixture({
            plugins: [
              {
                id: "custom",
                providers: ["custom", "other"],
                syntheticAuthRefs: ["custom", "other"],
                modelCatalog: {
                  providers: {
                    custom: { defaultUtilityModel, models: [{ id: "primary" }] },
                    other: { defaultUtilityModel: "other-small", models: [{ id: "primary" }] },
                  },
                },
              },
            ],
          });
          const context = createModelsListTestContext({
            cfg,
            agentId: "worker",
            agentDir: state.agentDir("worker"),
            workspaceDir: state.workspaceDir,
            catalog: [
              providerCatalogEntry("custom", "primary"),
              providerCatalogEntry("other", "primary"),
            ],
            metadataSnapshot,
          });
          const params = {
            agentId: "worker",
            view: "configured",
            preparedOnly: true,
          };
          const respond = vi.fn<RespondFn>();
          await modelsHandlers["models.list"]!({
            req: { type: "req", id: "global-utility", method: "models.list", params },
            client: null,
            context,
            params,
            respond,
            isWebchatConnect: () => false,
          });

          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              defaultModels: {
                automaticUtilityModel: defaultUtilityModel ? "custom/small@work" : null,
              },
            }),
            undefined,
          );
        },
      );
    },
  );

  it("projects personal-only models for the authenticated requester without publishing shared auth", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "personal-model-catalog-", env: WITHOUT_OPENAI_ENV_AUTH },
      async (state) => {
        const alice = ensureProfileForEmail("alice@example.test");
        const bob = ensureProfileForEmail("bob@example.test");
        const context = createModelsListTestContext({
          cfg: { agents: { defaults: { model: { primary: "test/default" } } } },
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          catalog: [],
          staticEntries: [catalogEntry("gpt-5.6-luna", "openai-chatgpt-responses")],
        });
        const read = async (profileId?: string) => {
          const params = {
            agentId: "main",
            view: "configured",
            preparedOnly: true,
            includeDefaultModels: false,
          };
          const respond = vi.fn<RespondFn>();
          await modelsHandlers["models.list"]!({
            req: { type: "req", id: "personal-catalog", method: "models.list", params },
            client: profileId
              ? {
                  connect: {
                    minProtocol: 4,
                    maxProtocol: 4,
                    client: { id: "cli", version: "test", platform: "test", mode: "cli" },
                    caps: [],
                  },
                  authenticatedUserProfile: {
                    profileId,
                    displayName: null,
                    hasAvatar: false,
                    updatedAt: 1,
                  },
                }
              : null,
            context,
            params,
            respond,
            isWebchatConnect: () => false,
          });
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          return respond.mock.calls[0]?.[1];
        };
        const shared = await read();
        expect(shared).toEqual({ models: [] });
        const unconfiguredPersonal = {
          models: [],
          accountSelection: { kind: "automatic", label: "Automatic account selection" },
        };
        expect(await read(alice.id)).toEqual(unconfiguredPersonal);
        connectUserModelAccount({
          ownerProfileId: alice.id,
          credential: {
            type: "oauth",
            provider: "openai",
            access: "synthetic-personal-access",
            refresh: "synthetic-personal-refresh",
            expires: Date.now() + 600_000,
          },
          assertCurrent() {},
        });

        const connected = await read(alice.id);
        expect(connected).toMatchObject({
          models: expect.arrayContaining([
            expect.objectContaining({ id: "gpt-5.6-luna", available: true }),
          ]),
        });
        expect(await read(bob.id)).toEqual(unconfiguredPersonal);
        expect(await read()).toEqual(shared);

        const merged = ensureProfileForEmail("alice-new@example.test");
        linkEmail("alice@example.test", merged.id);
        expect(await read(alice.id)).toEqual(connected);
        clearUserProfileAuthLink({ profileId: merged.id, provider: "openai" });
        expect(await read(alice.id)).toEqual(unconfiguredPersonal);
      },
    );
  });

  it("waits for the complete configured catalog when explicit refresh exceeds the browse deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const catalog = [
      { ...catalogEntry("gpt-5.6-luna", "openai-responses"), name: "Refreshed Luna" },
      { ...catalogEntry("gpt-5.6-sol", "openai-responses"), name: "Refreshed Sol" },
    ];
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": {}, "openai/gpt-5.6-sol": {} },
        },
      },
    } as OpenClawConfig;

    const result = listModels({
      catalog,
      catalogLoadDelayMs: 800,
      preparedCatalog: catalog.slice(0, 1),
      publishedCatalog: catalog.slice(0, 1),
      cfg: config,
      refresh: true,
      view: "configured",
    });

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);

    expect((await result).models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "gpt-5.6-luna", name: "Refreshed Luna" },
      { id: "gpt-5.6-sol", name: "Refreshed Sol" },
    ]);
  });

  it("keeps the published configured catalog when an implicit load exceeds the browse deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const publishedCatalog = [
      { ...catalogEntry("gpt-5.6-luna", "openai-responses"), name: "Published Luna" },
      { ...catalogEntry("gpt-5.6-sol", "openai-responses"), name: "Published Sol" },
    ];
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": {}, "openai/gpt-5.6-sol": {} },
        },
      },
    } as OpenClawConfig;

    const result = listModels({
      catalog: [],
      catalogLoadDelayMs: 800,
      publishedCatalog,
      cfg: config,
      view: "configured",
    });

    await vi.advanceTimersByTimeAsync(750);

    expect((await result).models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "gpt-5.6-luna", name: "Published Luna" },
      { id: "gpt-5.6-sol", name: "Published Sol" },
    ]);
  });

  it("projects a configured runtime model from prepared static facts", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol" } },
        list: [
          {
            id: "main",
            default: true,
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    } as OpenClawConfig;

    await expect(
      listModels({
        catalog: [],
        staticEntries: [
          catalogEntry("gpt-5.6-sol", "openai-responses"),
          catalogEntry("gpt-unconfigured", "openai-responses"),
        ],
        cfg: config,
        view: "configured",
      }),
    ).resolves.toEqual({
      defaultModels: { automaticUtilityModel: "openai/gpt-5.6-luna" },
      models: [
        expect.objectContaining({
          id: "gpt-5.6-sol",
          provider: "openai",
          agentRuntime: {
            id: "codex",
            cloudPlacementSupported: false,
            devicePlacementSupported: false,
            source: "model",
          },
        }),
      ],
    });
  });

  it("projects agent aliases onto inherited default and fallback catalog rows", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const cfg = {
        agents: {
          defaults: {
            model: {
              primary: "gpt-5.6-luna",
              fallbacks: ["claude-sonnet-4-6"],
            },
            models: {
              "openai/gpt-5.6-luna": { alias: "global-luna" },
              "anthropic/claude-sonnet-4-6": { alias: "global-sonnet" },
            },
          },
          entries: {
            main: {},
            worker: {
              models: {
                "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
                "anthropic/claude-sonnet-4-6": { alias: "worker-sonnet" },
              },
            },
          },
        },
      } as OpenClawConfig;

      const result = await listModels({
        agentId: "worker",
        cfg,
        view: "configured",
        catalog: [
          catalogEntry("gpt-5.6-luna", "openai-responses"),
          providerCatalogEntry("anthropic", "claude-sonnet-4-6"),
        ],
      });

      const projected = Object.fromEntries(
        result.models.map((model) => [model.id, { alias: model.alias, tags: model.tags }]),
      );
      expect(projected).toMatchObject({
        "gpt-5.6-luna": {
          alias: "global-luna",
          tags: ["default", "configured"],
        },
        "claude-sonnet-4-6": {
          alias: "worker-sonnet",
          tags: ["fallback#1", "configured"],
        },
      });
    });
  });

  it.each(["provider-config", "all"] as const)(
    "keeps shared role tags separate from agent aliases in the %s view",
    async (view) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "provider-config-role-tags-" },
        async () => {
          const modelIds = [
            "global-primary",
            "global-fallback",
            "shared",
            "agent-primary",
            "agent-fallback",
            "agent-configured",
          ];
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                model: { primary: "shared-primary", fallbacks: ["shared-fallback"] },
                models: {
                  "example/global-primary": { alias: "shared-primary" },
                  "example/global-fallback": { alias: "shared-fallback" },
                  "example/shared": {},
                },
              },
              entries: {
                worker: {
                  model: {
                    primary: "example/agent-primary",
                    fallbacks: ["example/agent-fallback"],
                  },
                  models: {
                    "example/global-primary": {
                      alias: "worker-primary-label",
                      agentRuntime: { id: "openclaw" },
                    },
                    "example/agent-configured": {},
                  },
                },
              },
            },
            models: {
              providers: {
                example: {
                  api: "openai-completions",
                  baseUrl: "https://models.example.test/v1",
                  apiKey: "synthetic-provider-key",
                  models: modelIds.map((id) => ({
                    id,
                    name: id,
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                  })),
                },
              },
            },
          };
          const catalog = modelIds.map((id) => providerCatalogEntry("example", id));
          const { request, respond } = requestModelsList({
            view,
            agentId: "worker",
            runtimeConfig: cfg,
            publishedCatalog: catalog,
            loadGatewayModelCatalog: vi.fn(async () => catalog),
            reqId: "provider-roles",
          });
          await request;
          const [ok, payload, error] = respond.mock.calls[0] ?? [];
          expect(ok, JSON.stringify(error)).toBe(true);
          expect(Value.Check(ModelsListResultSchema, payload)).toBe(true);
          const result = payload as ModelsListResult;
          expect(result.tagsScope).toBe(view === "provider-config" ? "defaults" : undefined);
          const models = result.models;
          const tags = Object.fromEntries(models.map((model) => [model.id, model.tags]));
          expect(tags).toEqual(
            view === "provider-config"
              ? {
                  "global-primary": ["default", "configured"],
                  "global-fallback": ["fallback#1", "configured"],
                  shared: ["configured"],
                  "agent-primary": undefined,
                  "agent-fallback": undefined,
                  "agent-configured": undefined,
                }
              : {
                  "global-primary": ["configured"],
                  "global-fallback": ["configured"],
                  shared: ["configured"],
                  "agent-primary": ["default"],
                  "agent-fallback": ["fallback#1"],
                  "agent-configured": ["configured"],
                },
          );
          expect(models.find((model) => model.id === "global-primary")).toMatchObject({
            alias: "worker-primary-label",
            agentRuntime: { id: "openclaw", source: "model" },
            available: true,
          });
        },
      );
    },
  );
});
