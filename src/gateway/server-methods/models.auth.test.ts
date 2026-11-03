import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  setupModelsListFixture,
  withoutOpenAIEnvAuth,
  withoutAnthropicEnvAuth,
  withModelsTestState,
  createDemoOAuthStore,
  catalogLoader,
  requestModelsList,
} from "./models-list.test-support.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./models-list.test-support.js"));

describe("models.list", () => {
  setupModelsListFixture();

  it("marks legacy OpenAI Codex aliases available through ChatGPT OAuth", async () => {
    await withoutOpenAIEnvAuth(async () => {
      await withModelsTestState({}, async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "openai:chatgpt": {
              type: "oauth",
              provider: "openai",
              access: "chatgpt-access",
              refresh: "chatgpt-refresh",
              expires: Date.now() + 30 * 60_000,
            },
          },
        });

        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog: catalogLoader([
            {
              id: "gpt-5.4-codex",
              name: "GPT-5.4 Codex",
              provider: "openai",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
            },
          ]),
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4 Codex",
                provider: "openai",
                agentRuntime: {
                  id: "codex",
                  cloudPlacementSupported: false,
                  devicePlacementSupported: false,
                  source: "implicit",
                },
                available: true,
              },
            ],
          },
          undefined,
        );
      });
    });
  });

  it.each([
    { authenticated: true, available: true, catalogComplete: false },
    { authenticated: false, available: false, catalogComplete: false },
    { authenticated: false, available: false, catalogComplete: true },
  ])(
    "projects native Claude runtime availability when authenticated=$authenticated, complete=$catalogComplete",
    async ({ authenticated, available, catalogComplete }) => {
      await withoutAnthropicEnvAuth(async () => {
        await withModelsTestState({}, async () => {
          cliBackendsTesting.setDepsForTest({
            resolveRuntimeCliBackends: () =>
              [{ id: "claude-cli", modelProvider: "anthropic", pluginId: "anthropic" }] as never,
          });
          try {
            const runtimeConfig = {
              agents: {
                defaults: {
                  models: {
                    "anthropic/claude-opus-4-8": {
                      agentRuntime: { id: "claude-cli" },
                    },
                  },
                },
              },
            } as unknown as OpenClawConfig;
            const { request, respond } = requestModelsList({
              view: "all",
              runtimeConfig,
              catalogComplete,
              preparedAuthModes: authenticated ? { "claude-cli": "api_key" } : {},
              loadGatewayModelCatalog: catalogLoader([
                {
                  id: "claude-opus-4-8",
                  name: "Claude Opus 4.8",
                  provider: "anthropic",
                },
              ]),
            });
            await request;

            expect(respond).toHaveBeenCalledWith(
              true,
              {
                models: [
                  {
                    id: "claude-opus-4-8",
                    name: "Claude Opus 4.8",
                    provider: "anthropic",
                    agentRuntime: {
                      id: "claude-cli",
                      cloudPlacementSupported: false,
                      devicePlacementSupported: false,
                      source: "model",
                    },
                    available,
                    tags: ["configured"],
                    ...(authenticated ? {} : { unavailableReason: "missing-auth" }),
                  },
                ],
              },
              undefined,
            );
          } finally {
            cliBackendsTesting.resetDepsForTest();
          }
        });
      });
    },
  );

  it("keeps file SecretRef provider availability unknown when read-only auth cannot resolve it", async () => {
    const catalog = [{ id: "llama-secure", name: "Llama Secure", provider: "vllm" }];
    const cfg = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig: cfg,
      loadGatewayModelCatalog: catalogLoader(catalog),
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [{ id: "llama-secure", name: "Llama Secure", provider: "vllm", available: false }],
      },
      undefined,
    );
  });

  it("keeps managed SecretRef provider availability unknown without runtime proof", async () => {
    const catalog = [{ id: "llama-managed", name: "Llama Managed", provider: "vllm" }];
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            apiKey: "secretref-managed",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig: cfg,
      loadGatewayModelCatalog: catalogLoader(catalog),
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          { id: "llama-managed", name: "Llama Managed", provider: "vllm", available: false },
        ],
      },
      undefined,
    );
  });

  it.each([
    "resolved-runtime-key",
    "ollama-local",
    "custom-local",
    "OPENAI_API_KEY",
    "secretref-managed",
    "secretref-env:UNRELATED_KEY",
    "${UNRELATED_KEY}",
    "$malformed-template",
  ])("uses an exact hydrated runtime snapshot with opaque key %s", async (apiKey) => {
    const sourceConfig: OpenClawConfig = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [],
          },
        },
      },
    };
    const sourceProvider = expectDefined(
      sourceConfig.models?.providers?.vllm,
      "source vLLM provider",
    );
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: {
            ...sourceProvider,
            apiKey,
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    try {
      for (const config of [sourceConfig, runtimeConfig]) {
        const { request, respond } = requestModelsList({
          view: "all",
          runtimeConfig: config,
          loadGatewayModelCatalog: catalogLoader([
            { id: "llama-secure", name: "Llama Secure", provider: "vllm" },
          ]),
        });
        await request;

        expect.soft(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              { id: "llama-secure", name: "Llama Secure", provider: "vllm", available: true },
            ],
          },
          undefined,
        );
      }
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not mark catalog rows available from expired OAuth profiles", async () => {
    await withModelsTestState({}, async (state) => {
      await state.writeAuthProfiles(
        createDemoOAuthStore({
          access: "expired-access",
          expires: Date.now() - 60_000,
        }),
      );

      const { request, respond } = requestModelsList({
        view: "all",
        loadGatewayModelCatalog: catalogLoader([
          { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
        ]),
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "demo-model",
              name: "Demo Model",
              provider: "demo-provider",
              available: false,
            },
          ],
        },
        undefined,
      );
    });
  });

  it("does not mix refreshed persisted OAuth into a stale runtime generation", async () => {
    await withModelsTestState({}, async (state) => {
      const agentDir = state.agentDir();
      await state.writeAuthProfiles(
        createDemoOAuthStore({
          access: "refreshed-access",
          expires: Date.now() + 60 * 60_000,
        }),
      );
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: createDemoOAuthStore({
            access: "expired-access",
            expires: Date.now() - 60_000,
          }),
        },
      ]);

      try {
        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog: catalogLoader([
            { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
          ]),
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: false,
              },
            ],
          },
          undefined,
        );
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
      }
    });
  });

  it("marks env SecretRef-backed auth profiles available", async () => {
    await withModelsTestState(
      {
        env: {
          DEMO_PROVIDER_TOKEN: "test-token",
        },
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "demo-provider:env": {
              type: "token",
              provider: "demo-provider",
              tokenRef: {
                source: "env",
                provider: "default",
                id: "DEMO_PROVIDER_TOKEN",
              },
              expires: Date.now() + 60_000,
            },
          },
        });

        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog: catalogLoader([
            { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
          ]),
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: true,
              },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("keeps non-env SecretRef-backed auth profile availability unknown", async () => {
    await withModelsTestState({}, async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "demo-provider:file": {
            type: "token",
            provider: "demo-provider",
            tokenRef: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/demo/token",
            },
            expires: Date.now() + 60_000,
          },
        },
      });

      const { request, respond } = requestModelsList({
        view: "all",
        runtimeConfig: {
          secrets: {
            providers: {
              "mounted-json": {
                source: "file",
                path: "/tmp/openclaw-test-secrets.json",
                mode: "json",
              },
            },
          },
        } as OpenClawConfig,
        loadGatewayModelCatalog: catalogLoader([
          { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
        ]),
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "demo-model",
              name: "Demo Model",
              provider: "demo-provider",
              available: false,
            },
          ],
        },
        undefined,
      );
    });
  });

  it("hides inline provider keys during billing cooldown from model browsing", async () => {
    // Regression: the models.list availability checker loaded the auth store
    // for profile checks but did not pass it to the runtime availability check,
    // so inline provider keys in billing cooldown stayed browseable.
    await withModelsTestState({}, async (state) => {
      const runtimeConfig = {
        models: {
          providers: {
            cliproxyapi: {
              api: "openai-responses",
              baseUrl: "https://cliproxy.example/v1",
              apiKey: "sk-inline-cooldown", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const catalog = [{ id: "qwen-remote", name: "Qwen Remote", provider: "cliproxyapi" }];
      const writeCooldown = (disabledUntil: number) =>
        state.writeAuthProfiles({
          version: 1,
          profiles: {},
          usageStats: {
            "inline-api-key:cliproxyapi": {
              disabledUntil,
              disabledReason: "billing",
            },
          },
        });

      const billingCooldownUntil = Date.now() + 60_000;
      await writeCooldown(billingCooldownUntil);
      const cooled = requestModelsList({
        view: "all",
        runtimeConfig,
        loadGatewayModelCatalog: catalogLoader(catalog),
      });
      await cooled.request;
      expect(cooled.respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "qwen-remote",
              name: "Qwen Remote",
              provider: "cliproxyapi",
              available: false,
              unavailableReason: "cooldown",
              unavailableUntil: billingCooldownUntil,
            },
          ],
        },
        undefined,
      );

      // Expired cooldown proves the store reaches the runtime check instead
      // of the row being unavailable for an unrelated reason.
      await writeCooldown(Date.now() - 60_000);
      const recovered = requestModelsList({
        view: "all",
        runtimeConfig,
        loadGatewayModelCatalog: catalogLoader(catalog),
      });
      await recovered.request;
      expect(recovered.respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            { id: "qwen-remote", name: "Qwen Remote", provider: "cliproxyapi", available: true },
          ],
        },
        undefined,
      );
    });
  });

  it("uses an exact hydrated runtime profile SecretRef as read-only proof", async () => {
    await withModelsTestState({}, async (state) => {
      const tokenRef = {
        source: "file" as const,
        provider: "mounted-json",
        id: "/providers/demo/token",
      };
      const persisted = {
        version: 1 as const,
        profiles: {
          "demo-provider:file": {
            type: "token" as const,
            provider: "demo-provider",
            tokenRef,
            expires: Date.now() + 10 * 60_000,
          },
        },
      };
      await state.writeAuthProfiles(persisted);
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir: state.agentDir(),
          store: {
            ...persisted,
            profiles: {
              "demo-provider:file": {
                ...persisted.profiles["demo-provider:file"],
                token: "resolved-runtime-token",
              },
            },
          },
        },
      ]);
      try {
        const { request, respond } = requestModelsList({
          view: "all",
          runtimeConfig: {
            secrets: {
              providers: {
                "mounted-json": {
                  source: "file",
                  path: "/tmp/openclaw-test-secrets.json",
                  mode: "json",
                },
              },
            },
          } as OpenClawConfig,
          loadGatewayModelCatalog: catalogLoader([
            { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
          ]),
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: true,
              },
            ],
          },
          undefined,
        );
      } finally {
        clearRuntimeAuthProfileStoreSnapshots();
      }
    });
  });

  it.each([
    {
      name: "unregistered file SecretRef",
      apiKey: { source: "file", provider: "mounted-json", id: "/providers/vllm/apiKey" },
      secrets: undefined,
      available: false,
      unavailableReason: "auth-failed",
    },
    {
      name: "unhydrated file SecretRef",
      apiKey: { source: "file", provider: "mounted-json", id: "/providers/vllm/apiKey" },
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      available: false,
      unavailableReason: undefined,
    },
    {
      name: "legacy managed marker",
      apiKey: "secretref-managed",
      secrets: undefined,
      available: true,
      unavailableReason: undefined,
    },
  ] as const)("honors $name ownership when another auth profile is usable", async (fixture) => {
    await withModelsTestState(
      {
        env: {
          OPENCLAW_TEST_PROFILE_API_KEY: "test-token",
          VLLM_API_KEY: undefined,
        },
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "vllm:env": {
              type: "api_key",
              provider: "vllm",
              keyRef: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_TEST_PROFILE_API_KEY",
              },
            },
          },
        });

        const cfg = {
          agents: {
            defaults: {
              models: {
                "vllm/*": {},
              },
            },
          },
          models: {
            providers: {
              vllm: {
                apiKey: fixture.apiKey,
              },
            },
          },
          ...(fixture.secrets ? { secrets: fixture.secrets } : {}),
        } as unknown as OpenClawConfig;

        const { request, respond } = requestModelsList({
          view: "all",
          runtimeConfig: cfg,
          loadGatewayModelCatalog: catalogLoader([
            { id: "llama-secure", name: "Llama Secure", provider: "vllm" },
          ]),
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "llama-secure",
                name: "Llama Secure",
                provider: "vllm",
                available: fixture.available,
                ...(fixture.unavailableReason
                  ? { unavailableReason: fixture.unavailableReason }
                  : {}),
              },
            ],
          },
          undefined,
        );
      },
    );
  });
});
