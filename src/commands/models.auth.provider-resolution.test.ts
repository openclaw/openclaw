// Models auth provider-resolution tests cover provider auth status grouping and selection.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearAuthProfileMigrationDiagnostics } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import * as migrationRuntime from "../plugins/migration-provider-runtime.js";
import { pluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type { MigrationItem, MigrationPlan, ProviderPlugin } from "../plugins/types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { tryImportProviderCredential } from "./models/auth-credential-import.js";
import { resolveRequestedLoginProviderOrThrow, runModelsAuthLoginFlowCore } from "./models/auth.js";

function makeProvider(params: { id: string; label?: string; aliases?: string[] }): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    aliases: params.aliases,
    auth: [],
  };
}

describe("selected credential import", () => {
  const method: ProviderPlugin["auth"][number] = {
    id: "api-key",
    label: "Key",
    kind: "api_key",
    run: async () => ({ profiles: [] }),
    credentialImport: {
      migrationProviderId: "fixture",
      itemId: "auth:key",
      credentialKind: "api_key",
    },
  };
  const keyItem: MigrationItem = {
    id: "auth:key",
    kind: "auth",
    action: "create",
    status: "planned",
    details: { provider: "fixture", credentialKind: "api_key", profileId: "fixture:imported" },
  };

  it("imports only the declared credential and preserves model configuration", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "other/model" },
          models: { "other/model": {} },
        },
      },
    };
    const items: MigrationItem[] = [
      keyItem,
      { id: "auth:oauth", kind: "auth", action: "create", status: "planned" },
    ];
    const plan: MigrationPlan = {
      providerId: "fixture",
      source: "/fixture",
      items,
      summary: summarizeMigrationItems(items),
    };
    const persisted: string[] = [];
    const resolve = vi
      .spyOn(migrationRuntime, "withPluginMigrationProviders")
      .mockImplementation(async (_params, run) =>
        run([
          {
            id: "fixture",
            label: "Fixture",
            plan: () => plan,
            apply(ctx, selected) {
              if (!selected) {
                throw new Error("Expected selected import plan");
              }
              expect(ctx.providerOptions?.configPatchMode).toBe("none");
              const resultItems = selected.items.map((item) => {
                if (item.status !== "planned") {
                  return item;
                }
                persisted.push(item.id);
                return { ...item, status: "migrated" as const };
              });
              return {
                ...selected,
                items: resultItems,
                summary: summarizeMigrationItems(resultItems),
              };
            },
          },
        ]),
      );
    try {
      const result = await tryImportProviderCredential({
        method,
        providerId: "fixture",
        config,
        agentId: "main",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });
      expect(result).toMatchObject({
        profileId: "fixture:imported",
        provider: "fixture",
        mode: "api_key",
      });
      expect(persisted).toEqual(["auth:key"]);
      expect(config.agents?.defaults?.model).toEqual({ primary: "other/model" });
      expect(config.agents?.defaults?.models).toEqual({ "other/model": {} });
    } finally {
      resolve.mockRestore();
    }
  });

  it.each(["cancelled", "changed", "ambiguous", "wrong-provider"])(
    "refuses a %s import without starting another sign-in",
    async (failure) => {
      const controller = new AbortController();
      const items =
        failure === "ambiguous"
          ? [keyItem, keyItem]
          : failure === "wrong-provider"
            ? [{ ...keyItem, details: { ...keyItem.details, provider: "other" } }]
            : [keyItem];
      const plan: MigrationPlan = {
        providerId: "fixture",
        source: "/fixture",
        items,
        summary: summarizeMigrationItems(items),
      };
      const apply = vi.fn(() => ({ ...plan, items: [{ ...keyItem, status: "skipped" as const }] }));
      const resolve = vi
        .spyOn(migrationRuntime, "withPluginMigrationProviders")
        .mockImplementation(async (_params, run) =>
          run([
            {
              id: "fixture",
              label: "Fixture",
              plan: () => {
                if (failure === "cancelled") {
                  controller.abort(new Error("Sign-in cancelled"));
                }
                return plan;
              },
              apply,
            },
          ]),
        );
      try {
        await expect(
          tryImportProviderCredential({
            method,
            providerId: "fixture",
            config: {},
            agentId: "main",
            signal: controller.signal,
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          }),
        ).rejects.toThrow(
          failure === "cancelled"
            ? "Sign-in cancelled"
            : failure === "changed"
              ? "changed during import"
              : failure === "ambiguous"
                ? "ambiguous item identity"
                : "another provider",
        );
        if (failure !== "changed") {
          expect(apply).not.toHaveBeenCalled();
        }
      } finally {
        resolve.mockRestore();
      }
    },
  );
});

describe("resolveRequestedLoginProviderOrThrow", () => {
  it("returns null and resolves provider by id/alias", () => {
    const providers = [
      makeProvider({ id: "google-gemini-cli", aliases: ["gemini-cli"] }),
      makeProvider({ id: "openai", aliases: ["openai"] }),
      makeProvider({ id: "minimax-portal" }),
    ];
    const scenarios = [
      { requested: undefined, expectedId: null },
      { requested: "google-gemini-cli", expectedId: "google-gemini-cli" },
      { requested: "gemini-cli", expectedId: "google-gemini-cli" },
      { requested: "openai", expectedId: "openai" },
    ] as const;

    for (const scenario of scenarios) {
      const result = resolveRequestedLoginProviderOrThrow(providers, scenario.requested);
      expect(result?.id ?? null).toBe(scenario.expectedId);
    }
  });

  it("throws when requested provider is not loaded", () => {
    const loadedProviders = [
      makeProvider({ id: "google-gemini-cli" }),
      makeProvider({ id: "minimax-portal" }),
    ];

    expect(() =>
      resolveRequestedLoginProviderOrThrow(loadedProviders, "google-antigravity"),
    ).toThrowError(
      'Unknown provider "google-antigravity". Loaded providers: google-gemini-cli, minimax-portal. Verify plugins via `openclaw plugins list --json`.',
    );
  });
});

describe("models auth login explicit credential selection", () => {
  it.each([
    "force",
    "profile-id",
    "set-default",
    "unavailable-import",
    "concurrent-config",
    "concurrent-providers",
    "concurrent-models",
    "stale-models",
    "conflicting-models",
    "model-update",
    "source-models",
    "canonical-models",
    "runtime-canonical-models",
    "config-rejected",
    "absent-default",
  ])("uses fresh authentication for %s with the gateway stopped", async (selection) => {
    const mergedModels = selection === "concurrent-models" || selection === "stale-models";
    const modelConflict = selection === "conflicting-models";
    const modelUpdate = mergedModels || modelConflict || selection === "model-update";
    const canonicalModels =
      selection === "canonical-models" || selection === "runtime-canonical-models";
    const state = await createOpenClawTestState({
      label: "auth-force-login",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_OAUTH_DIR: undefined,
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_PORT: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    const importOwner = vi.spyOn(migrationRuntime, "withPluginMigrationProviders");
    if (selection === "unavailable-import") {
      importOwner.mockImplementation(async (_params, run) =>
        run([
          {
            id: "authstore-proof",
            label: "Auth store proof",
            plan() {
              const items: MigrationItem[] = [
                {
                  id: "auth:shared",
                  kind: "auth",
                  action: "skip",
                  status: "skipped",
                  message: "The existing sign-in needs to be renewed.",
                  details: { credentialImportUnavailable: true },
                },
              ];
              return {
                providerId: "authstore-proof",
                source: "/fixture",
                items,
                summary: summarizeMigrationItems(items),
              };
            },
            apply() {
              throw new Error("Unavailable credentials cannot be applied");
            },
          },
        ]),
      );
    } else {
      importOwner.mockRejectedValue(
        new Error("Explicit credential selection must not acquire an import owner"),
      );
    }
    try {
      pluginLoaderCacheState.clear();
      resetPluginRuntimeStateForTest();
      const provider = "authstore-proof";
      const freshId = `${provider}:${selection === "profile-id" ? "selected" : "fresh"}`;
      const fresh = { type: "token" as const, provider, token: "fixture-fresh-token" };
      const expired = { ...fresh, token: "fixture-expired-token", expires: 1 };
      const unrelated = {
        type: "token" as const,
        provider: "other-proof",
        token: "fixture-other",
      };
      const pluginDir = path.join(state.workspaceDir, ".openclaw", "extensions", provider);
      await fs.mkdir(pluginDir, { recursive: true, mode: 0o755 });
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: provider,
          providers: [provider],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "index.cjs"),
        `module.exports = {
          id: ${JSON.stringify(provider)},
          register(api) {
            api.registerProvider({
              id: ${JSON.stringify(provider)}, label: "Auth store proof",
              auth: [{ id: "token", label: "Fixture token", kind: "token",
                credentialImport: { migrationProviderId: ${JSON.stringify(provider)}, itemId: "auth:shared", credentialKind: "token" },
                async run({ config }) {
                  const result = ${JSON.stringify({ profiles: [{ profileId: `${provider}:fresh`, credential: fresh }], defaultModel: `${provider}/recommended` })};
                  if (${JSON.stringify(selection)} === "concurrent-config" || ${JSON.stringify(selection)} === "concurrent-providers") {
                    const concurrent = ${JSON.stringify(selection)} === "concurrent-providers"
                      ? { models: { providers: { "other-proof": {
                          baseUrl: "https://other.invalid", api: "openai-completions", models: []
                        } } } }
                      : { logging: { level: "debug" } };
                    await require("node:fs/promises").writeFile(process.env.OPENCLAW_CONFIG_PATH,
                      JSON.stringify({ ...config, ...concurrent }));
                    result.configPatch = { ...config, models: { providers: {
                      "authstore-proof": { baseUrl: "https://fixture.invalid", api: "openai-completions", models: [] }
                    } } };
                  } else if (${JSON.stringify(modelUpdate)}) {
                    const connection = config.models.providers[${JSON.stringify(provider)}];
                    const original = connection.models[0];
                    if (${JSON.stringify(selection)} === "concurrent-models" || ${JSON.stringify(modelConflict)}) {
                      await require("node:fs/promises").writeFile(process.env.OPENCLAW_CONFIG_PATH,
                        JSON.stringify({ ...config, models: { providers: {
                          ${JSON.stringify(provider)}: { ...connection, models: [
                            { ...original, contextWindow: 8192, name: ${JSON.stringify(modelConflict)} ? "Concurrent update" : original.name },
                            { ...original, id: "concurrent" }
                          ] }
                        } } }));
                    }
                    result.configPatch = { models: { providers: {
                      ${JSON.stringify(provider)}: { ...connection, models: [{ id: original.id, name: "Login update" }] }
                    } } };
                  } else if (${JSON.stringify(canonicalModels)}) {
                    const connection = config.models.providers.google;
                    result.configPatch = { models: { providers: { google: {
                      ...connection, models: connection.models.map(model => ({ ...model, name: "Login update" }))
                    } } } };
                  } else if (${JSON.stringify(selection)} === "source-models") {
                    result.configPatch = { agents: { defaults: { models: { "authstore-proof/recommended": {} } } } };
                  } else if (${JSON.stringify(selection)} === "config-rejected") {
                    result.configPatch = { gateway: { port: -1 } };
                  } else if (${JSON.stringify(selection)} === "absent-default") {
                    result.configPatch = { agents: { defaults: { model: "authstore-proof/recommended" } } };
                  }
                  return result;
                }
              }]
            });
          }
        };`,
      );
      const originalModel = {
        id: "original",
        name: "Original",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      };
      const modelConnection = {
        baseUrl: "https://fixture.invalid",
        api: "openai-completions" as const,
        models: [originalModel],
      };
      const config: OpenClawConfig = {
        agents: {
          ...(selection === "source-models"
            ? {}
            : {
                defaults:
                  selection === "absent-default"
                    ? {}
                    : { model: { primary: "other-proof/existing" } },
              }),
          list: [{ id: "main", workspace: state.workspaceDir }],
        },
        plugins: { allow: [provider], entries: { [provider]: { enabled: true } } },
        logging: { level: "info" },
        ...(modelUpdate || canonicalModels
          ? {
              models: {
                providers: {
                  [provider]: modelConnection,
                  ...(canonicalModels
                    ? {
                        google: {
                          ...modelConnection,
                          models: [{ ...originalModel, id: "google/gemini-3-pro-preview" }],
                        },
                      }
                    : {}),
                },
              },
            }
          : {}),
        gateway: {
          mode: "local",
          port: await getFreePort(),
          auth: { mode: "token", token: "fixture-gateway-token" },
        },
      };
      await state.writeConfig(config);
      if (selection === "stale-models") {
        await state.writeConfig({
          ...config,
          models: {
            providers: {
              [provider]: {
                ...modelConnection,
                models: [
                  { ...originalModel, contextWindow: 8192 },
                  { ...originalModel, id: "concurrent" },
                ],
              },
            },
          },
        });
      }
      saveAuthProfileStore(
        {
          version: 1,
          profiles: { [`${provider}:shared`]: expired, "other-proof:shared": unrelated },
        },
        undefined,
        { sharedStoreWrite: true, filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      await state.writeAuthProfiles({
        version: 1,
        profiles: { [`${provider}:local`]: expired, "other-proof:local": unrelated },
        order: { [provider]: [`${provider}:local`] },
      });
      const unexpectedPrompt = async (): Promise<never> => {
        throw new Error("Unexpected interactive prompt in explicit fixture login");
      };
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const login = runModelsAuthLoginFlowCore({
        provider,
        method: "token",
        agent: "main",
        ...(selection === "force"
          ? { force: true }
          : selection === "profile-id"
            ? { profileId: freshId }
            : selection === "set-default"
              ? { setDefault: true }
              : selection !== "unavailable-import"
                ? { profileId: freshId }
                : {}),
        ...(selection === "runtime-canonical-models" ? {} : { config }),
        runtime,
        prompter: createWizardPrompter({
          select: unexpectedPrompt,
          text: unexpectedPrompt,
          confirm: unexpectedPrompt,
        }),
      });
      if (modelConflict) {
        await expect
          .soft(login)
          .rejects.toThrow("Credentials saved, but provider settings could not be applied");
      } else if (selection === "config-rejected") {
        await expect(login).rejects.toThrow(
          "Credentials saved, but provider settings could not be applied",
        );
      } else {
        await login;
      }

      const savedConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(savedConfig.agents.defaults.model?.primary).toBe(
        selection === "set-default"
          ? "authstore-proof/recommended"
          : selection === "absent-default" || selection === "source-models"
            ? undefined
            : "other-proof/existing",
      );
      if (selection === "concurrent-config") {
        expect(savedConfig.logging.level).toBe("debug");
        expect(savedConfig.models.providers[provider].baseUrl).toBe("https://fixture.invalid");
      }
      if (selection === "concurrent-providers") {
        expect(savedConfig.models.providers[provider].baseUrl).toBe("https://fixture.invalid");
        expect(savedConfig.models.providers["other-proof"].baseUrl).toBe("https://other.invalid");
      }
      if (selection === "source-models") {
        expect(savedConfig.agents.defaults.models).toHaveProperty("authstore-proof/recommended");
      }
      if (canonicalModels) {
        expect(savedConfig.models.providers.google.models).toMatchObject([
          { id: "google/gemini-3.1-pro-preview", name: "Login update" },
        ]);
      }
      if (modelConflict || mergedModels) {
        expect(savedConfig.models.providers[provider].models).toMatchObject([
          {
            id: "original",
            name: modelConflict ? "Concurrent update" : "Login update",
            contextWindow: 8192,
            maxTokens: 1024,
          },
          { id: "concurrent", name: "Original" },
        ]);
      } else if (selection === "model-update") {
        expect(savedConfig.models.providers[provider].models).toMatchObject([
          { id: "original", name: "Login update", contextWindow: 4096, maxTokens: 1024 },
        ]);
      }
      expect(loadPersistedAuthProfileStore()?.profiles).toEqual({
        ...(selection !== "force" ? { [`${provider}:shared`]: expired } : {}),
        [freshId]: fresh,
        "other-proof:shared": unrelated,
      });
      const local = loadPersistedAuthProfileStore(state.agentDir());
      expect(local?.profiles).toEqual({
        ...(selection !== "force" ? { [`${provider}:local`]: expired } : {}),
        "other-proof:local": unrelated,
      });
      expect(loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles).toEqual({
        ...(selection !== "force"
          ? { [`${provider}:shared`]: expired, [`${provider}:local`]: expired }
          : {}),
        [freshId]: fresh,
        "other-proof:shared": unrelated,
        "other-proof:local": unrelated,
      });
      if (selection === "force") {
        expect(local?.order?.[provider]).toBeUndefined();
        expect(runtime.log).toHaveBeenCalledWith(
          `Removed cached auth profiles for provider "${provider}" (--force). Running fresh auth flow.`,
        );
      }
      if (selection !== "config-rejected" && !modelConflict) {
        expect(runtime.log).toHaveBeenCalledWith(`Auth profile: ${freshId} (${provider}/token)`);
      }
    } finally {
      importOwner.mockRestore();
      pluginLoaderCacheState.clear();
      resetPluginRuntimeStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      clearAuthProfileMigrationDiagnostics();
      await state.cleanup();
    }
  });
});
