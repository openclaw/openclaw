import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { clearAuthProfileMigrationDiagnostics } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import { writeFixtureJson } from "../cli/cli-fixtures.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import * as migrationRuntime from "../plugins/migration-provider-runtime.js";
import { getPluginLoaderCacheState } from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderPlugin,
  ProviderPlugin,
} from "../plugins/types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { tryImportProviderCredential } from "./models/auth-credential-import.js";
import { resolveRequestedLoginProviderOrThrow, runModelsAuthLoginFlowCore } from "./models/auth.js";
import { createTestModelDefinition } from "./test-runtime-config-helpers.js";

function makeProvider(params: { id: string; label?: string; aliases?: string[] }): ProviderPlugin {
  return { ...params, label: params.label ?? params.id, auth: [] };
}

function credentialPlan(items: MigrationItem[], providerId = "fixture"): MigrationPlan {
  return { providerId, source: "/fixture", items, summary: summarizeMigrationItems(items) };
}

function mockCredentialProvider(provider: MigrationProviderPlugin) {
  return vi
    .spyOn(migrationRuntime, "withPluginMigrationProviders")
    .mockImplementation(async (_params, run) => run([provider]));
}

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
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

it.each([undefined, "cancelled", "changed", "ambiguous", "wrong-provider"])(
  "imports only the declared credential or rejects %s without another sign-in",
  async (failure) => {
    const controller = new AbortController();
    const config: OpenClawConfig = failure
      ? {}
      : {
          agents: {
            defaults: { model: { primary: "other/model" }, models: { "other/model": {} } },
          },
        };
    const items: MigrationItem[] = [keyItem];
    if (failure === "ambiguous") {
      items.push(keyItem);
    } else if (failure === "wrong-provider") {
      items[0] = { ...keyItem, details: { ...keyItem.details, provider: "other" } };
    } else if (!failure) {
      items.push({ id: "auth:oauth", kind: "auth", action: "create", status: "planned" });
    }
    const plan = credentialPlan(items);
    const persisted: string[] = [];
    const apply = vi.fn<MigrationProviderPlugin["apply"]>((ctx, selected) => {
      if (failure) {
        return { ...plan, items: [{ ...keyItem, status: "skipped" }] };
      }
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
      return { ...selected, items: resultItems, summary: summarizeMigrationItems(resultItems) };
    });
    const resolve = mockCredentialProvider({
      id: "fixture",
      label: "Fixture",
      apply,
      plan: () => {
        if (failure === "cancelled") {
          controller.abort(new Error("Sign-in cancelled"));
        }
        return plan;
      },
    });
    try {
      const operation = tryImportProviderCredential({
        method,
        providerId: "fixture",
        config,
        agentId: "main",
        ...(failure ? { signal: controller.signal } : {}),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });
      if (failure) {
        const errors: Record<string, string> = {
          cancelled: "Sign-in cancelled",
          changed: "changed during import",
          ambiguous: "ambiguous item identity",
          "wrong-provider": "another provider",
        };
        await expect(operation).rejects.toThrow(errors[failure]);
        if (failure !== "changed") {
          expect(apply).not.toHaveBeenCalled();
        }
      } else {
        expect(await operation).toMatchObject({
          profileId: "fixture:imported",
          provider: "fixture",
          mode: "api_key",
        });
        expect(persisted).toEqual(["auth:key"]);
        expect(config.agents?.defaults).toEqual({
          model: { primary: "other/model" },
          models: { "other/model": {} },
        });
      }
    } finally {
      resolve.mockRestore();
    }
  },
);

it.each([
  [undefined, null],
  ["google-gemini-cli", "google-gemini-cli"],
  ["gemini-cli", "google-gemini-cli"],
  ["openai", "openai"],
  ["google-antigravity", "error"],
] as const)("resolves %s", (requested, expected) => {
  const providers = [
    makeProvider({ id: "google-gemini-cli", aliases: ["gemini-cli"] }),
    ...(expected === "error" ? [] : [makeProvider({ id: "openai", aliases: ["openai"] })]),
    makeProvider({ id: "minimax-portal" }),
  ];
  if (expected === "error") {
    expect(() => resolveRequestedLoginProviderOrThrow(providers, requested)).toThrowError(
      'Unknown provider "google-antigravity". Loaded providers: google-gemini-cli, minimax-portal. Verify plugins via `openclaw plugins list --json`.',
    );
  } else {
    expect(resolveRequestedLoginProviderOrThrow(providers, requested)?.id ?? null).toBe(expected);
  }
});

it.each([
  "force",
  "profile-id",
  "set-default",
  "unavailable-import",
  "credential-only",
  "revoked-after-save",
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
  "consent-all",
  "consent-keep",
  "consent-legacy-all",
  "consent-legacy-keep",
  "consent-legacy-set-default-all",
  "consent-legacy-set-default-keep",
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
  const provider = "authstore-proof";
  const unavailable: MigrationItem = {
    id: "auth:shared",
    kind: "auth",
    action: "skip",
    status: "skipped",
    message: "The existing sign-in needs to be renewed.",
    details: { credentialImportUnavailable: true },
  };
  const importOwner =
    selection === "unavailable-import"
      ? mockCredentialProvider({
          id: provider,
          label: "Auth store proof",
          plan: () => credentialPlan([unavailable], provider),
          apply() {
            throw new Error("Unavailable credentials cannot be applied");
          },
        })
      : vi
          .spyOn(migrationRuntime, "withPluginMigrationProviders")
          .mockRejectedValue(
            new Error("Explicit credential selection must not acquire an import owner"),
          );
  try {
    getPluginLoaderCacheState().clear();
    resetPluginRuntimeStateForTest();
    const freshId = `${provider}:${selection === "profile-id" ? "selected" : "fresh"}`;
    const fresh = { type: "token" as const, provider, token: "fixture-fresh-token" };
    const expired = { ...fresh, token: "fixture-expired-token", expires: 1 };
    const unrelated = { type: "token" as const, provider: "other-proof", token: "fixture-other" };
    const pluginDir = path.join(state.workspaceDir, ".openclaw", "extensions", provider);
    await fs.mkdir(pluginDir, { recursive: true, mode: 0o755 });
    await writeFixtureJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: provider,
      providers: [provider],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    });
    await fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
          id: ${JSON.stringify(provider)},
          register(api) {
            api.registerProvider({
              id: ${JSON.stringify(provider)}, label: "Auth store proof",
              auth: [{ id: "token", label: "Fixture token", kind: "token",
                credentialImport: { migrationProviderId: ${JSON.stringify(provider)}, itemId: "auth:shared", credentialKind: "token" },
                async run({ config, credentialOnly }) {
                  const patchConnection = (id, value) => ({ models: { providers: { [id]: value } } });
                  const patchDefaults = value => ({ agents: { defaults: value } });
                  const write = value => require("node:fs/promises").writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(value));
                  const result = ${JSON.stringify({ profiles: [{ profileId: `${provider}:fresh`, credential: fresh }], defaultModel: `${provider}/recommended` })};
                  if (${JSON.stringify(selection)} === "credential-only") {
                    if (!credentialOnly) throw new Error("Credential-only login attempted starter discovery");
                    result.configPatch = ${JSON.stringify({ agents: { defaults: { model: { primary: "authstore-proof/recommended" }, models: { "authstore-proof/*": {} } } } })};
                  } else if (${JSON.stringify(selection)} === "concurrent-config" || ${JSON.stringify(selection)} === "concurrent-providers") {
                    const connection = { baseUrl: "https://fixture.invalid", api: "openai-completions", models: [] };
                    const concurrent = ${JSON.stringify(selection)} === "concurrent-providers"
                      ? patchConnection("other-proof", { ...connection, baseUrl: "https://other.invalid" })
                      : { logging: { level: "debug" } };
                    await write({ ...config, ...concurrent });
                    result.configPatch = { ...config, ...patchConnection("authstore-proof", connection) };
                  } else if (${JSON.stringify(modelUpdate || canonicalModels)}) {
                    const id = ${JSON.stringify(canonicalModels)} ? "google" : ${JSON.stringify(provider)};
                    const connection = config.models.providers[id];
                    const original = connection.models[0];
                    if (${JSON.stringify(selection)} === "concurrent-models" || ${JSON.stringify(modelConflict)}) {
                      await write({ ...config, ...patchConnection(id, {
                        ...connection, models: [
                          { ...original, contextWindow: 8192, name: ${JSON.stringify(modelConflict)} ? "Concurrent update" : original.name },
                          { ...original, id: "concurrent" },
                        ],
                      }) });
                    }
                    const models = ${JSON.stringify(canonicalModels)} ? connection.models : [{ id: original.id }];
                    result.configPatch = patchConnection(id, { ...connection,
                      models: models.map(model => ({ ...model, name: "Login update" })) });
                  } else if (${JSON.stringify(selection)} === "source-models") {
                    result.configPatch = patchDefaults({ models: { "authstore-proof/recommended": {} } });
                  } else if (${JSON.stringify(selection)} === "config-rejected") {
                    result.configPatch = { gateway: { port: -1 } };
                  } else if (${JSON.stringify(selection)} === "absent-default") {
                    result.configPatch = patchDefaults({ model: "authstore-proof/recommended" });
                  } else if (${JSON.stringify(selection.startsWith("consent-"))}) {
                    result.configPatch = patchDefaults({ modelPolicy: { allow: ["authstore-proof/*"] }, models: { "authstore-proof/recommended": {} } });
                  }
                  return result;
                }
              }]
            });
          }
        };`,
    );
    const originalModel = createTestModelDefinition("original", {
      name: "Original",
      contextWindow: 4096,
      maxTokens: 1024,
    });
    const modelConnection = {
      baseUrl: "https://fixture.invalid",
      api: "openai-completions" as const,
      models: [originalModel],
    };
    const defaults: Defaults =
      selection === "absent-default" ? {} : { model: { primary: "other-proof/existing" } };
    if (selection.startsWith("consent-")) {
      Object.assign(
        defaults,
        selection.includes("-legacy-")
          ? { models: { "existing-model": {} } }
          : { modelPolicy: { allow: ["other-proof/existing"] } },
      );
    }
    const config: OpenClawConfig = {
      agents: {
        ...(selection === "source-models" ? {} : { defaults }),
        entries: { main: { workspace: state.workspaceDir } },
      },
      plugins: { allow: [provider], entries: { [provider]: { enabled: true } } },
      logging: { level: "info" },
      gateway: {
        mode: "local",
        port: await getFreePort(),
        auth: { mode: "token", token: "fixture-gateway-token" },
      },
    };
    if (modelUpdate || canonicalModels) {
      const google = {
        ...modelConnection,
        models: [{ ...originalModel, id: "google/gemini-3-pro-preview" }],
      };
      config.models = {
        providers: { [provider]: modelConnection, ...(canonicalModels ? { google } : {}) },
      };
    }
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
    let consentAsked = false;
    const force = selection === "force";
    const setDefault = selection === "set-default" || selection.includes("-set-default-");
    const credentialOnly = selection === "credential-only" || selection === "revoked-after-save";
    const login = runModelsAuthLoginFlowCore({
      provider,
      method: "token",
      agent: "main",
      force: force || undefined,
      setDefault: setDefault || undefined,
      credentialOnly: credentialOnly || undefined,
      profileId:
        force || setDefault || credentialOnly || selection === "unavailable-import"
          ? undefined
          : freshId,
      assertCurrent:
        selection === "revoked-after-save"
          ? () => {
              if (loadPersistedAuthProfileStore()?.profiles[freshId]) {
                throw new Error("Login authority was revoked after the credential write.");
              }
            }
          : undefined,
      ...(selection === "runtime-canonical-models" ? {} : { config }),
      runtime,
      prompter: createWizardPrompter({
        select: async (prompt) => {
          if (!selection.startsWith("consent-")) {
            return unexpectedPrompt();
          }
          expect(loadPersistedAuthProfileStore()?.profiles[freshId]).toEqual(fresh);
          expect(prompt.options.map((option) => option.label)).toEqual([
            "Show all Auth store proof models",
            "Keep current restrictions",
          ]);
          const answer = prompt.options.find(
            (option) => option.value === (selection.endsWith("all") ? "all" : "keep"),
          );
          if (!answer) {
            throw new Error("Model access choice missing");
          }
          consentAsked = true;
          return answer.value;
        },
        text: unexpectedPrompt,
        confirm: unexpectedPrompt,
      }),
    });
    if (selection === "revoked-after-save") {
      await expect(login).rejects.toThrow("credentials were saved");
    } else if (modelConflict || selection === "config-rejected") {
      await (modelConflict ? expect.soft(login) : expect(login)).rejects.toThrow(
        "Credentials saved, but provider settings could not be applied",
      );
    } else {
      await login;
    }
    const savedConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    if (selection.startsWith("consent-")) {
      expect(consentAsked).toBe(true);
      if (selection.includes("-legacy-")) {
        expect(savedConfig.agents.defaults.models).toEqual(
          selection.endsWith("all")
            ? { "existing-model": {}, "authstore-proof/*": {} }
            : { "existing-model": {} },
        );
      } else {
        expect(savedConfig.agents.defaults.modelPolicy.allow).toEqual(
          selection === "consent-all"
            ? ["other-proof/existing", "authstore-proof/*"]
            : ["other-proof/existing"],
        );
      }
    }
    expect(savedConfig.agents.defaults.model?.primary).toBe(
      setDefault
        ? "authstore-proof/recommended"
        : selection === "absent-default" || selection === "source-models"
          ? undefined
          : "other-proof/existing",
    );
    if (selection === "concurrent-config") {
      expect(savedConfig.logging.level).toBe("debug");
      expect(savedConfig.models.providers[provider].baseUrl).toBe("https://fixture.invalid");
    }
    if (selection === "credential-only") {
      expect(savedConfig.agents.defaults.models).toBeUndefined();
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
    if (modelUpdate) {
      expect(savedConfig.models.providers[provider].models).toMatchObject([
        {
          id: "original",
          name: modelConflict ? "Concurrent update" : "Login update",
          contextWindow: modelConflict || mergedModels ? 8192 : 4096,
          maxTokens: 1024,
        },
        ...(modelConflict || mergedModels ? [{ id: "concurrent", name: "Original" }] : []),
      ]);
    }
    const sharedProfiles = {
      ...(selection !== "force" ? { [`${provider}:shared`]: expired } : {}),
      [freshId]: fresh,
      "other-proof:shared": unrelated,
    };
    const localProfiles = {
      ...(selection !== "force" ? { [`${provider}:local`]: expired } : {}),
      "other-proof:local": unrelated,
    };
    const local = loadPersistedAuthProfileStore(state.agentDir());
    expect(loadPersistedAuthProfileStore()?.profiles).toEqual(sharedProfiles);
    expect(local?.profiles).toEqual(localProfiles);
    expect(loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles).toEqual({
      ...sharedProfiles,
      ...localProfiles,
    });
    if (selection === "force") {
      expect(local?.order?.[provider]).toBeUndefined();
      expect(runtime.log).toHaveBeenCalledWith(
        `Removed cached auth profiles for provider "${provider}" (--force). Running fresh auth flow.`,
      );
    }
    if (selection === "revoked-after-save") {
      expect(local?.order?.[provider]).toEqual([`${provider}:local`]);
    } else if (selection !== "config-rejected" && !modelConflict) {
      expect(runtime.log).toHaveBeenCalledWith(`Auth profile: ${freshId} (${provider}/token)`);
    }
  } finally {
    importOwner.mockRestore();
    getPluginLoaderCacheState().clear();
    resetPluginRuntimeStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearAuthProfileMigrationDiagnostics();
    await state.cleanup();
  }
});
