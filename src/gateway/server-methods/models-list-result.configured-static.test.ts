import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
} from "../../state/user-model-accounts.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

  it("keeps the utility runtime on the prepared catalog's plugin generation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "utility-runtime-generation-" },
      async (state) => {
        const registries = ["Prepared Runtime", "Ambient Runtime"].map((label) => {
          const registry = createEmptyPluginRegistry();
          registry.agentHarnesses.push({
            pluginId: "utility-runtime",
            source: "runtime",
            harness: {
              id: "utility-runtime",
              label,
              supports: () => ({ supported: true }),
              runAttempt: vi.fn(),
              runIsolatedCompletionV2: vi.fn(),
            },
          });
          return registry;
        });
        const [preparedRegistry, ambientRegistry] = registries;
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              custom: {
                api: "openai-completions",
                baseUrl: "https://custom.example/v1",
                apiKey: "synthetic-key",
                models: [],
              },
            },
          },
          agents: {
            defaults: {
              model: "custom/primary",
              utilityModel: "custom/small",
              models: { "custom/small": { agentRuntime: { id: "utility-runtime" } } },
            },
          },
        };
        const result = await withPluginRuntimeRegistryScope(ambientRegistry, () =>
          listModels({
            cfg,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            view: "configured",
            preparedOnly: true,
            pluginRegistry: preparedRegistry,
            metadataSnapshot: createPluginMetadataSnapshotFixture({
              plugins: [{ id: "custom", providers: ["custom"], syntheticAuthRefs: ["custom"] }],
            }),
            catalog: [
              providerCatalogEntry("custom", "primary"),
              providerCatalogEntry("custom", "small"),
            ],
          }),
        );

        expect(result.defaultModels?.utilityRuntime).toEqual({
          id: "utility-runtime",
          kind: "harness",
          label: "Prepared Runtime",
        });
      },
    );
  });

  it("projects utility runtimes for API, subscription, unavailable, and disabled selections", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "utility-runtime-api-key-", env: WITHOUT_OPENAI_ENV_AUTH },
      async (state) => {
        const cfg: OpenClawConfig = {
          plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
              utilityModel: "openai/gpt-5.5",
              models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
            },
          },
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                apiKey: "synthetic-api-key",
                models: [],
              },
            },
          },
        };
        const pluginRegistry = loadOpenClawPlugins({
          config: cfg,
          onlyPluginIds: ["codex"],
          activate: false,
          cache: false,
        });
        const plugin = pluginRegistry.plugins.find((entry) => entry.id === "codex");
        expect(plugin?.status, plugin?.error).toBe("loaded");
        const result = await withPluginRuntimeRegistryScope(pluginRegistry, () =>
          listModels({
            cfg,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            view: "configured",
            preparedOnly: true,
            pluginRegistry,
            catalog: [catalogEntry("gpt-5.5", "openai-responses")],
          }),
        );
        expect(result.defaultModels).toEqual({
          automaticUtilityModel: "openai/gpt-5.6-luna",
          utilityRuntime: { id: "openclaw", kind: "api", label: "OpenClaw Default" },
        });
        // The same real registration must also respect native, missing, and exhausted auth.
        const pinnedConfig: OpenClawConfig = {
          ...cfg,
          models: undefined,
          agents: {
            defaults: { ...cfg.agents?.defaults, utilityModel: "openai/gpt-5.5@openai:utility" },
          },
        };
        const subscription: AuthProfileStore = {
          version: 1,
          profiles: {
            "openai:utility": {
              type: "oauth",
              provider: "openai",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: Date.now() + 3_600_000,
            },
          },
        };
        for (const [name, authStore, expected] of [
          ["subscription", subscription, { id: "codex", kind: "harness", label: "OpenAI Codex" }],
          ["missing", { version: 1, profiles: {} }, undefined],
          ["disabled", subscription, undefined],
          [
            "exhausted",
            {
              ...subscription,
              usageStats: { "openai:utility": { cooldownUntil: Date.now() + 3_600_000 } },
            },
            undefined,
          ],
        ] as const) {
          const projected = await listModels({
            cfg:
              name === "disabled"
                ? {
                    ...pinnedConfig,
                    agents: { defaults: { ...pinnedConfig.agents?.defaults, utilityModel: "" } },
                  }
                : pinnedConfig,
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            view: "configured",
            preparedOnly: true,
            pluginRegistry,
            preparedAuthStore: authStore,
            catalog: [catalogEntry("gpt-5.5", "openai-chatgpt-responses")],
          });
          expect(projected.defaultModels, name).toEqual({
            automaticUtilityModel: "openai/gpt-5.6-luna",
            ...(expected ? { utilityRuntime: expected } : {}),
          });
        }
      },
    );
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

  it.each([true, false])(
    "uses the correct configured catalog past the browse deadline (refresh=%s)",
    async (refresh) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const catalog = [
        {
          ...catalogEntry("gpt-5.6-luna", "openai-responses"),
          name: `${refresh ? "Refreshed" : "Published"} Luna`,
        },
        {
          ...catalogEntry("gpt-5.6-sol", "openai-responses"),
          name: `${refresh ? "Refreshed" : "Published"} Sol`,
        },
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
        catalog: refresh ? catalog : [],
        catalogLoadDelayMs: 800,
        preparedCatalog: refresh ? catalog.slice(0, 1) : undefined,
        publishedCatalog: refresh ? catalog.slice(0, 1) : catalog,
        cfg: config,
        refresh,
        view: "configured",
      });

      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(750);
      if (refresh) {
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(50);
      }

      expect((await result).models.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: "gpt-5.6-luna", name: `${refresh ? "Refreshed" : "Published"} Luna` },
        { id: "gpt-5.6-sol", name: `${refresh ? "Refreshed" : "Published"} Sol` },
      ]);
    },
  );

  it("projects a configured runtime model from prepared static facts", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol" } },
        entries: {
          main: {
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
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
      defaultModels: {
        automaticUtilityModel: "openai/gpt-5.6-luna",
      },
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
});
