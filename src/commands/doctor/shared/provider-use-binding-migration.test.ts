import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAuthProfileStoreForRuntime } from "../../../agents/auth-profiles.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../../../agents/auth-profiles/upsert-with-lock.js";
import { resolveProviderUseAdmission } from "../../../agents/provider-model-auth-source-plan.js";
import { readConfigFileSnapshot } from "../../../config/io.js";
import { prepareProviderUseBindingMigration } from "../../../config/provider-use-binding-plan.js";
import { getConfigProviderUseBindings } from "../../../config/resolution-facts.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SecretRef } from "../../../config/types.secrets.js";
import { acquireFileLockSyncWithRetry } from "../../../infra/file-lock-sync.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../../../infra/state-migrations.receipts.js";
import { resolveProviderBindingEnvVarCandidates } from "../../../secrets/provider-env-vars.js";
import { runOpenClawAgentWriteTransaction } from "../../../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  completeProviderUseBindingMigration,
  revalidateProviderUseBindingMigration,
  writeProviderUseBindingMigration,
} from "./provider-use-binding-migration.js";

vi.mock("./active-tool-schema-warnings.js", () => ({
  collectActiveToolSchemaProjectionWarnings: async () => [],
}));

const bundledPlugins = fileURLToPath(new URL("../../../../extensions/", import.meta.url));
const selectedPlan: OpenClawConfig = {
  agents: {
    defaults: { model: "byteplus-plan/ark-code-latest" },
    entries: { main: {} },
  },
};
const byteplusRef = {
  source: "env",
  provider: "default",
  id: "BYTEPLUS_API_KEY",
} satisfies SecretRef;
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "provider-binding-migration",
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPlugins,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      BYTEPLUS_API_KEY: "fixture-byteplus-key",
      VOLCANO_ENGINE_API_KEY: "fixture-volcengine-key",
      MINIMAX_API_KEY: "fixture-minimax-shared-key",
      MINIMAX_CODE_PLAN_KEY: undefined,
      MINIMAX_CODING_API_KEY: undefined,
      MINIMAX_OAUTH_TOKEN: undefined,
      OPENCODE_API_KEY: "fixture-opencode-shared-key",
      OPENCODE_ZEN_API_KEY: undefined,
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      MODEL_API_KEY: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_PROFILE: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
    },
  });
});

afterEach(async () => {
  await state.cleanup();
});

function prepare(config: OpenClawConfig) {
  return prepareProviderUseBindingMigration({
    config,
    configPath: state.configPath,
    env: state.env,
  });
}

it("defers shared-key bindings without failing when account publication is busy", async () => {
  const migration = prepare(selectedPlan);
  assert(migration.bindings);
  const release = acquireFileLockSyncWithRetry(
    path.join(state.stateDir, "auth-profile-publication"),
  );
  const publish = vi.fn();
  try {
    const result = await writeProviderUseBindingMigration(
      {
        config: { ...migration.config, browser: { enabled: false } },
        sourceConfig: selectedPlan,
        configPath: state.configPath,
        env: state.env,
        bindings: migration.bindings,
      },
      async (checked, withCommit) => {
        if (withCommit) {
          withCommit(publish);
        } else {
          expect(checked.config.models?.providers?.["byteplus-plan"]).toBeUndefined();
          expect(checked.config.browser?.enabled).toBe(false);
        }
      },
    );
    expect(publish).not.toHaveBeenCalled();
    expect(result.pending).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("bindings were deferred");
  } finally {
    release();
  }
});

function admitted(config: OpenClawConfig) {
  return resolveProviderUseAdmission({
    config,
    env: state.env,
    providerEnvVars: resolveProviderBindingEnvVarCandidates({ config, env: state.env }),
  });
}

describe("selected shared-provider upgrade", () => {
  it("persists a selected binding even when validation already supplied its runtime-only facts", async () => {
    const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
    const { runWriteConfigHealth } =
      await import("../../../flows/doctor-health-contribution-runners.config.js");
    await state.writeConfig(selectedPlan);
    const snapshot = await readConfigFileSnapshot({ observe: false });
    expect(snapshot.sourceConfig.models?.providers?.["byteplus-plan"]).toBeUndefined();
    expect(getConfigProviderUseBindings(snapshot.sourceConfig)["byteplus-plan"]).toEqual({
      apiKey: byteplusRef,
    });
    expect(prepare(snapshot.sourceConfig).bindings?.["byteplus-plan"]).toEqual({
      apiKey: byteplusRef,
    });

    const context = await prepareDoctorContext(state.configPath);
    await runWriteConfigHealth(context, { runPostWriteRepairs: false });

    expect(
      JSON.parse(await fs.readFile(state.configPath, "utf8")).models.providers["byteplus-plan"],
    ).toEqual({ apiKey: byteplusRef });
    expect(prepare(selectedPlan).pending).toBe(false);
  });

  it("keeps a newly selected shared-key fallback pending at the write recheck", async () => {
    const prepared = prepare(selectedPlan);
    assert(prepared.bindings);
    const config = structuredClone(prepared.config);
    config.agents = {
      ...config.agents,
      defaults: {
        model: {
          primary: "byteplus-plan/ark-code-latest",
          fallbacks: ["volcengine-plan/ark-code-latest"],
        },
      },
    };
    const checked = revalidateProviderUseBindingMigration({
      config,
      configPath: state.configPath,
      env: state.env,
      bindings: prepared.bindings,
    });
    expect(checked.pending).toBe(false);
    expect(checked.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
    expect(checked.config.models?.providers?.["volcengine-plan"]).toBeUndefined();
    expect(checked.warnings.join("\n")).toContain("volcengine-plan");
  });

  it("leaves completion open when one selected service key is missing despite another repair", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "byteplus-plan/ark-code-latest",
            fallbacks: ["volcengine-plan/ark-code-latest"],
          },
        },
        entries: { main: {} },
      },
    };
    const result = prepareProviderUseBindingMigration({
      config,
      configPath: state.configPath,
      env: { ...state.env, BYTEPLUS_API_KEY: undefined },
    });
    expect(result.pending).toBe(false);
    expect(result.config.models?.providers?.["byteplus-plan"]).toBeUndefined();
    expect(result.config.models?.providers?.["volcengine-plan"]?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "VOLCANO_ENGINE_API_KEY",
    });
    expect(result.warnings?.join("\n")).toContain("BYTEPLUS_API_KEY");
  });

  it.each(["main", "other", "shared"])(
    "does not replace a saved family account in the %s scope with an env binding",
    async (scope) => {
      const profileId = "byteplus:saved-account";
      await persistAuthProfileBatch({
        stateDir: state.stateDir,
        ...(scope === "shared" ? {} : { agentDir: state.agentDir(scope) }),
        profiles: [
          {
            profileId,
            credential: { type: "api_key", provider: "byteplus", key: "saved-account-key" },
          },
        ],
      });

      const result = prepare(selectedPlan);

      expect(result.config).toBe(selectedPlan);
      expect(result.changes).toEqual([]);
      expect(result.pending).toBe(false);
      expect(result.warnings?.join("\n")).toContain("byteplus-plan");
      expect(result.warnings?.join("\n")).toContain(profileId);
      expect(result.warnings?.join("\n")).not.toContain("saved-account-key");
      expect(prepare(selectedPlan).changes).toEqual([]);
      const withoutEnv = prepareProviderUseBindingMigration({
        config: selectedPlan,
        configPath: state.configPath,
        env: { ...state.env, BYTEPLUS_API_KEY: undefined },
      });
      expect(withoutEnv.config).toBe(selectedPlan);
      expect(withoutEnv.warnings?.join("\n")).toContain(profileId);
    },
  );

  it.each([true, false])(
    "defers a conflicting local account without losing safe bindings (owner selects it: %s)",
    async (ownerSelectsProvider) => {
      const config: OpenClawConfig = {
        agents: {
          entries: {
            alpha: {
              model: ownerSelectsProvider ? "byteplus-plan/ark-code-latest" : "openai/fixture",
            },
            beta: {
              model: {
                primary: "byteplus-plan/ark-code-latest",
                fallbacks: ["volcengine-plan/ark-code-latest"],
              },
            },
          },
        },
      };
      const alphaAccount: AuthProfileStore = {
        version: 1,
        profiles: {
          "byteplus-plan:alpha": {
            type: "api_key",
            provider: "byteplus-plan",
            key: "private-alpha-key",
          },
        },
      };
      await state.writeAuthProfiles(alphaAccount, "alpha");
      const readProfiles = (agentId: string) =>
        loadAuthProfileStoreForRuntime(
          state.agentDir(agentId),
          { config, readOnly: true, allowKeychainPrompt: false },
          state.env,
        ).profiles;
      expect(readProfiles("alpha")).toEqual(alphaAccount.profiles);
      expect(readProfiles("beta")).toEqual({});
      const before = structuredClone(config);

      const result = prepare(config);

      expect(result.pending).toBe(false);
      expect(result.config.models?.providers?.["byteplus-plan"]).toBeUndefined();
      expect(result.config.models?.providers?.["volcengine-plan"]?.apiKey).toEqual({
        source: "env",
        provider: "default",
        id: "VOLCANO_ENGINE_API_KEY",
      });
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toEqual([
        expect.stringContaining("Provider byteplus-plan was not migrated for agents beta"),
      ]);
      expect(result.warnings?.[0]).toContain("existing account for agents alpha");
      expect(result.warnings?.join("\n")).not.toContain("private-alpha-key");
      expect(config).toEqual(before);
      expect(readProfiles("alpha")).toEqual(alphaAccount.profiles);
      expect(readProfiles("beta")).toEqual({});
      const repeated = prepare(result.config);
      expect(repeated.pending).toBe(false);
      expect(repeated.changes).toEqual([]);

      // The operator repairs only beta through the existing account owner.
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: {
            "byteplus-plan:beta": {
              type: "api_key",
              provider: "byteplus-plan",
              keyRef: byteplusRef,
            },
          },
        },
        "beta",
      );
      const repaired = prepare(result.config);
      expect(repaired.pending).toBe(true);
      expect(repaired.changes).toEqual([]);
      expect(repaired.warnings).toBeUndefined();
      expect(readProfiles("alpha")).toEqual(alphaAccount.profiles);
      expect(completeProviderUseBindingMigration(state.configPath, state.env)).toEqual([]);
      expect(prepare(result.config).pending).toBe(false);
    },
  );

  it("keeps the agent owner of a persisted pin when deciding migration conflicts", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: { alpha: { model: "openai/fixture" }, beta: { model: "openai/fixture" } },
      },
    };
    await state.writeAuthProfiles(
      {
        version: 1,
        profiles: {
          "byteplus-plan:alpha": {
            type: "api_key",
            provider: "byteplus-plan",
            key: "private-alpha-key",
          },
        },
      },
      "alpha",
    );
    const scope = {
      agentId: "beta",
      env: state.env,
      storePath: path.join(state.sessionsDir("beta"), "sessions.json"),
      sessionKey: "agent:beta:pinned",
    };
    await replaceSessionEntry(scope, {
      sessionId: "beta-pin",
      updatedAt: 1,
      providerOverride: "byteplus-plan",
      modelOverride: "ark-code-latest",
      modelOverrideSource: "user",
    });
    const before = loadSessionEntry(scope);

    const result = prepare(config);

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
    expect(result.pending).toBe(false);
    expect(result.warnings).toEqual([
      expect.stringContaining("Provider byteplus-plan was not migrated for agents beta"),
    ]);
    expect(result.warnings?.[0]).toContain("existing account for agents alpha");
    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it("preserves another agent's inactive saved account before materializing an env binding", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          alpha: { model: "openai/fixture" },
          beta: { model: "byteplus-plan/ark-code-latest" },
        },
      },
    };
    const inactive: AuthProfileStore = {
      version: 1,
      profiles: {
        "byteplus-plan:replacement": {
          type: "api_key",
          provider: "byteplus-plan",
          key: "inactive-alpha-key",
          setup: { replacement: true, modelRef: "byteplus-plan/ark-code-latest", configJson: "{}" },
        },
      },
    };
    await state.writeAuthProfiles(inactive, "alpha");

    const result = prepare(config);

    expect(result.pending).toBe(false);
    expect(result.warnings?.join("\n")).toContain("byteplus-plan:replacement");
    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
    expect(
      loadAuthProfileStoreForRuntime(
        state.agentDir("alpha"),
        {
          config,
          readOnly: true,
          allowKeychainPrompt: false,
        },
        state.env,
      ).profiles,
    ).toEqual(inactive.profiles);
  });

  it.each(["entries", "list"] as const)(
    "preserves default, fallback and per-agent selections from the %s roster",
    async (roster) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: "byteplus-plan/ark-code-latest",
              fallbacks: ["volcengine-plan/ark-code-latest"],
            },
          },
          ...(roster === "entries"
            ? { entries: { main: {}, worker: { model: "opencode/fixture-model" } } }
            : { list: [{ id: "main" }, { id: "worker", model: "opencode/fixture-model" }] }),
        },
      };
      const original = structuredClone(config);

      const result = prepare(config);

      expect(result.pending).toBe(true);
      expect(result.config.models?.providers).toEqual({
        "byteplus-plan": { apiKey: byteplusRef, baseUrl: "", models: [] },
        "volcengine-plan": {
          apiKey: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
          baseUrl: "",
          models: [],
        },
        opencode: {
          apiKey: { source: "env", provider: "default", id: "OPENCODE_API_KEY" },
          baseUrl: "",
          models: [],
        },
      });
      expect(config).toEqual(original);
      expect(admitted(result.config).has("byteplus-plan")).toBe(true);
      expect(admitted(result.config).has("volcengine-plan")).toBe(true);
      expect(admitted(result.config).has("opencode")).toBe(true);
      expect(admitted(result.config).has("opencode-go")).toBe(false);
      for (const provider of ["minimax", "minimax-portal"]) {
        expect(result.config.models?.providers?.[provider]).toBeUndefined();
        expect(admitted(result.config).get(provider)).toEqual({
          kind: "environment",
          envVar: "MINIMAX_API_KEY",
        });
      }
      const second = prepare(result.config);
      expect(second.config).toBe(result.config);
      expect(second.changes).toEqual([]);
    },
  );

  it.each(["primary", "fallback"] as const)(
    "preserves a selected %s alias without enrolling unselected siblings",
    async (position) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model:
              position === "primary"
                ? { primary: "plan" }
                : { primary: "openai/gpt-5.4", fallbacks: ["plan"] },
            models: {
              "byteplus-plan/ark-code-latest": { alias: "plan" },
              "minimax-portal/MiniMax-M2.7": { alias: "unused" },
            },
          },
          entries: { main: {} },
        },
      };
      const original = structuredClone(config);

      const result = prepare(config);

      expect(Object.keys(result.config.models?.providers ?? {})).toEqual(["byteplus-plan"]);
      expect(result.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
      expect(config).toEqual(original);
    },
  );

  it.each(["entries", "list"] as const)(
    "resolves selected aliases in each agent's scope from the %s roster",
    async (roster) => {
      const worker = {
        model: "plan",
        models: { "volcengine-plan/ark-code-latest": { alias: "plan" } },
      };
      const inherited = { models: { "opencode/fixture-model": { alias: "plan" } } };
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "plan",
            models: {
              "byteplus-plan/ark-code-latest": { alias: "plan" },
              "opencode-go/fixture-model": { alias: "unused" },
            },
          },
          ...(roster === "entries"
            ? { entries: { main: {}, worker, inherited } }
            : {
                list: [
                  { id: "main" },
                  { id: "worker", ...worker },
                  { id: "inherited", ...inherited },
                ],
              }),
        },
      };
      const original = structuredClone(config);

      const result = prepare(config);

      expect(Object.keys(result.config.models?.providers ?? {}).toSorted()).toEqual([
        "byteplus-plan",
        "opencode",
        "volcengine-plan",
      ]);
      expect(result.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
      expect(result.config.models?.providers?.["volcengine-plan"]?.apiKey).toEqual({
        source: "env",
        provider: "default",
        id: "VOLCANO_ENGINE_API_KEY",
      });
      expect(result.config.models?.providers?.opencode?.apiKey).toEqual({
        source: "env",
        provider: "default",
        id: "OPENCODE_API_KEY",
      });
      expect(admitted(result.config).has("opencode-go")).toBe(false);
      expect(config).toEqual(original);
    },
  );

  it("preserves persisted user and legacy pins without promoting automatic fallbacks", async () => {
    const config: OpenClawConfig = { agents: { entries: { main: {}, worker: {} } } };
    const pins: Array<{ agentId: string; name: string; entry: SessionEntry }> = [
      {
        agentId: "main",
        name: "user",
        entry: {
          sessionId: "pin-user",
          updatedAt: 1,
          providerOverride: "byteplus-plan",
          modelOverride: "ark-code-latest",
          modelOverrideSource: "user",
        },
      },
      {
        agentId: "worker",
        name: "legacy",
        entry: {
          sessionId: "pin-legacy",
          updatedAt: 2,
          providerOverride: "volcengine-plan",
          modelOverride: "volcengine-plan/ark-code-latest",
        },
      },
      {
        agentId: "main",
        name: "automatic",
        entry: {
          sessionId: "pin-auto",
          updatedAt: 3,
          providerOverride: "opencode",
          modelOverride: "fixture-model",
          modelOverrideSource: "auto",
        },
      },
      {
        agentId: "worker",
        name: "default",
        entry: {
          sessionId: "pin-default",
          updatedAt: 4,
          providerOverride: "opencode-go",
          modelOverride: "fixture-model",
          modelOverrideSource: "default",
        },
      },
      {
        agentId: "worker",
        name: "legacy-automatic",
        entry: {
          sessionId: "pin-legacy-auto",
          updatedAt: 5,
          providerOverride: "opencode-go",
          modelOverride: "fixture-model",
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "fixture-model",
        },
      },
    ];
    const scopes = pins.map(({ agentId, name }) => ({
      agentId,
      storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
      sessionKey: `agent:${agentId}:${name}`,
      env: state.env,
    }));
    for (let index = 0; index < pins.length; index += 1) {
      await replaceSessionEntry(scopes[index]!, pins[index]!.entry);
    }
    const before = scopes.map((scope) => loadSessionEntry(scope));

    const result = prepare(config);

    expect(Object.keys(result.config.models?.providers ?? {}).toSorted()).toEqual([
      "byteplus-plan",
      "volcengine-plan",
    ]);
    expect(result.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
    expect(scopes.map((scope) => loadSessionEntry(scope))).toEqual(before);
    expect(admitted(result.config).has("opencode")).toBe(false);
    expect(admitted(result.config).has("opencode-go")).toBe(false);
  });

  it("declares selected chain providers without activating generic credentials or unselected siblings", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-4o",
            fallbacks: ["amazon-bedrock/fixture", "anthropic-vertex/fixture"],
          },
        },
      },
    };
    const env = {
      ...state.env,
      GITHUB_TOKEN: "fixture-github-token",
      GH_TOKEN: "fixture-gh-token",
      MODEL_API_KEY: "fixture-generic-key",
      AWS_PROFILE: "default",
      AWS_ACCESS_KEY_ID: "fixture-access",
      AWS_SECRET_ACCESS_KEY: "fixture-secret",
      GOOGLE_APPLICATION_CREDENTIALS: state.path("fixture-adc.json"),
    };
    await fs.writeFile(
      env.GOOGLE_APPLICATION_CREDENTIALS,
      JSON.stringify({ type: "authorized_user" }),
    );

    const result = prepareProviderUseBindingMigration({
      config,
      configPath: state.configPath,
      env,
    });

    expect(result.bindings).toEqual({ "amazon-bedrock": {}, "anthropic-vertex": {} });
    expect(Object.keys(result.config.models?.providers ?? {})).toEqual([
      "amazon-bedrock",
      "anthropic-vertex",
    ]);
    expect(result.pending).toBe(true);
    const unselected = prepareProviderUseBindingMigration({
      config: {},
      configPath: state.configPath,
      env,
    });
    expect(unselected.config.models?.providers).toBeUndefined();
  });

  it.each(["amazon-bedrock", "amazon-bedrock-mantle", "anthropic-vertex", "google-vertex"])(
    "preserves a stored account instead of materializing a chain declaration for %s",
    async (provider) => {
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: {
            [`${provider}:saved`]: { type: "api_key", provider, key: "fixture-saved-account" },
          },
        },
        "other",
      );
      const config: OpenClawConfig = {
        agents: { defaults: { model: `${provider}/fixture` }, entries: { main: {} } },
      };
      const result = prepare(config);
      expect(result.config).toBe(config);
      expect(result.pending).toBe(false);
      expect(result.warnings?.join("\n")).toContain(`${provider}:saved`);
    },
  );

  it("repairs a narrow receipt for new selectors while respecting an old primary binding removal", () => {
    const sourceKey = resolveLegacyMigrationSourceKey(
      "selected-shared-provider-bindings:v1",
      state.configPath,
    );
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        recordLegacyMigrationReceipt(db, {
          sourceKey,
          migrationKind: "selected-shared-provider-bindings:v1",
          sourcePath: state.configPath,
          targetTable: "migration_sources",
          sourceSha256: null,
          sourceSizeBytes: null,
          sourceRecordCount: null,
          runId: sourceKey,
          now: 1,
          reportJson: JSON.stringify({ completed: true, target: "models.providers" }),
        }),
      { env: state.env },
    );
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "byteplus-plan/ark-code-latest",
          subagents: { model: "volcengine-plan/ark-code-latest" },
          utilityModel: "google-vertex/fixture",
        },
        entries: { main: {} },
      },
    };

    const result = prepare(config);

    expect(result.config.models?.providers?.["byteplus-plan"]).toBeUndefined();
    expect(result.bindings).toEqual({
      "volcengine-plan": {
        apiKey: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
      },
      "google-vertex": {},
    });
    expect(completeProviderUseBindingMigration(state.configPath, state.env)).toEqual([]);
    const receipt = runOpenClawStateWriteTransaction(
      ({ db }) => readLegacyMigrationReceiptFromDatabase(db, sourceKey),
      { env: state.env },
    );
    expect(JSON.parse(receipt?.reportJson ?? "null")).toMatchObject({ selectionVersion: 2 });
    expect(prepare(config)).toEqual({ config, changes: [], pending: false });
  });

  it.each(["provider-config", "profile"] as const)(
    "does not require a shared env variable when %s already binds the selected provider",
    async (source) => {
      const config: OpenClawConfig = {
        ...selectedPlan,
        ...(source === "provider-config"
          ? {
              models: {
                providers: {
                  "byteplus-plan": { apiKey: "fixture-explicit-account", baseUrl: "", models: [] },
                },
              },
            }
          : {}),
      };
      if (source === "profile") {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "byteplus-plan:saved": {
              type: "api_key",
              provider: "byteplus-plan",
              key: "fixture-saved-account",
            },
          },
        });
      }
      const env = { ...state.env, BYTEPLUS_API_KEY: undefined };

      const result = prepareProviderUseBindingMigration({
        config,
        configPath: state.configPath,
        env,
      });

      expect(result.config).toBe(config);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toBeUndefined();
      expect(result.pending).toBe(true);
      expect(completeProviderUseBindingMigration(state.configPath, env)).toEqual([]);
      expect(
        prepareProviderUseBindingMigration({ config, configPath: state.configPath, env }),
      ).toEqual({
        config,
        changes: [],
        pending: false,
      });
    },
  );

  it("preserves an existing selected account instead of replacing it with a shared env key", async () => {
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "byteplus-plan:work": {
          type: "api_key",
          provider: "byteplus-plan",
          key: "fixture-account-key",
        },
      },
    });

    const result = prepare(selectedPlan);

    expect(result.config).toBe(selectedPlan);
    expect(result.changes).toEqual([]);
    expect(result.config.models?.providers?.["byteplus-plan"]).toBeUndefined();
  });

  it.each([
    '{"models":null}',
    '{"models":{"providers":[]}}',
    '{"agents":{"defaults":{"model":{"primary":9,"fallbacks":[null,3,{}]}},"entries":{"broken":null}}}',
  ])("leaves malformed operator shapes intact: %s", async (serialized) => {
    const config: OpenClawConfig = JSON.parse(serialized);
    const result = prepare(config);
    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
  });

  it("does not reopen a completed upgrade after binding removal or a later selection", async () => {
    const migrated = prepare(selectedPlan);
    expect(migrated.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
    expect(completeProviderUseBindingMigration(state.configPath, state.env)).toEqual([]);

    for (const model of ["byteplus-plan/ark-code-latest", "volcengine-plan/ark-code-latest"]) {
      const config: OpenClawConfig = { agents: { defaults: { model } } };
      const result = prepare(config);
      expect(result).toEqual({ config, changes: [], pending: false });
      expect(admitted(result.config).has(model.split("/")[0]!)).toBe(false);
    }
  });

  it.each(["17", "null", "{}"])("defers an invalid env SecretRef alias %s", async (alias) => {
    const config: OpenClawConfig = JSON.parse(
      `{"agents":{"defaults":{"model":"byteplus-plan/ark-code-latest"}},"secrets":{"defaults":{"env":${alias}}}}`,
    );
    expect(prepare(config)).toEqual({ config, changes: [], pending: false });
  });

  it("closes an empty successful upgrade before a new shared-key selection appears", async () => {
    const empty = prepare({ agents: { entries: { main: {} } } });
    expect(empty.changes).toEqual([]);
    expect(empty.pending).toBe(true);
    expect(completeProviderUseBindingMigration(state.configPath, state.env)).toEqual([]);

    const result = prepare(selectedPlan);
    expect(result).toEqual({ config: selectedPlan, changes: [], pending: false });
    expect(admitted(result.config).has("byteplus-plan")).toBe(false);
  });

  it("defers an incomplete recovered session inventory without binding or completing", async () => {
    const scope = {
      agentId: "main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:damaged",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "damaged",
      updatedAt: 1,
      providerOverride: "byteplus-plan",
      modelOverride: "ark-code-latest",
      modelOverrideSource: "user",
    });
    // Deliberate corruption bypasses the normal writer so Doctor sees a recoverable row.
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
          "{",
          scope.sessionKey,
        );
      },
      { agentId: "main", env: state.env },
    );

    const result = prepare(selectedPlan);

    expect(result).toMatchObject({ config: selectedPlan, changes: [], pending: false });
    expect(result.warnings).toEqual([expect.stringContaining("Rerun")]);
  });

  it("defers unreadable receipt state without creating a provider binding", async () => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a SQLite database");

    const result = prepare(selectedPlan);

    expect(result).toMatchObject({ config: selectedPlan, changes: [], pending: false });
    expect(result.warnings).toEqual([expect.stringContaining("Rerun")]);
  });
});

describe("Doctor provider-binding write composition", () => {
  it("keeps an unevaluated service-environment selection open until its key is visible", async () => {
    const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
    const { runWriteConfigHealth } =
      await import("../../../flows/doctor-health-contribution-runners.config.js");
    await state.writeConfig(selectedPlan);
    vi.stubEnv("BYTEPLUS_API_KEY", undefined);
    const absent = prepareProviderUseBindingMigration({
      config: selectedPlan,
      configPath: state.configPath,
      env: { ...state.env, BYTEPLUS_API_KEY: undefined },
    });
    const shellDoctor = await prepareDoctorContext(state.configPath);
    await runWriteConfigHealth(shellDoctor, { runPostWriteRepairs: false });

    vi.stubEnv("BYTEPLUS_API_KEY", state.env.BYTEPLUS_API_KEY);
    const retry = prepare(selectedPlan);
    expect(retry.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
    expect(absent.pending).toBe(false);
    expect(absent.warnings?.join("\n")).toContain("BYTEPLUS_API_KEY");
    expect(absent.warnings?.join("\n")).toContain("service environment");
    const serviceDoctor = await prepareDoctorContext(state.configPath);
    await runWriteConfigHealth(serviceDoctor, { runPostWriteRepairs: false });
    const written = await fs.readFile(state.configPath, "utf8");
    expect(JSON.parse(written).models.providers["byteplus-plan"]).toEqual({ apiKey: byteplusRef });

    const third = await prepareDoctorContext(state.configPath);
    await runWriteConfigHealth(third, { runPostWriteRepairs: false });
    expect(await fs.readFile(state.configPath, "utf8")).toBe(written);
    expect(prepare(selectedPlan)).toEqual({
      config: selectedPlan,
      changes: [],
      pending: false,
    });
  });

  it.each([false, true])(
    "persists a primary Plan binding and later repair fields: %s",
    async (laterRepair) => {
      const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
      const { runWriteConfigHealth } =
        await import("../../../flows/doctor-health-contribution-runners.config.js");
      await state.writeConfig({
        ...selectedPlan,
        gateway: { mode: "local", auth: { mode: "token", token: "fixture-gateway-token" } },
        env: { vars: { BYTEPLUS_API_KEY: "fixture-byteplus-key" } },
      });

      const context = await prepareDoctorContext(state.configPath);
      expect(context.configResult.shouldWriteConfig).toBe(true);
      const provider = context.cfg.models?.providers?.["byteplus-plan"];
      assert(provider);
      if (laterRepair) {
        provider.baseUrl = "https://provider.example/v1";
        provider.models = [
          {
            id: "fixture",
            name: "Fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          },
        ];
      }
      const expected = laterRepair ? structuredClone(provider) : { apiKey: byteplusRef };
      await runWriteConfigHealth(context, { runPostWriteRepairs: false });

      const persisted: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(persisted.models?.providers?.["byteplus-plan"]).toEqual(expected);
      context.cfg.gateway = { ...context.cfg.gateway, port: 19491 };
      await runWriteConfigHealth(context, { runPostWriteRepairs: false });
      const afterHealthRepair: OpenClawConfig = JSON.parse(
        await fs.readFile(state.configPath, "utf8"),
      );
      expect(afterHealthRepair.models?.providers?.["byteplus-plan"]).toEqual(expected);
      expect(afterHealthRepair.gateway?.port).toBe(19491);
      expect(context.configWriteRefusal).toBeUndefined();
      expect(prepare(selectedPlan)).toEqual({
        config: selectedPlan,
        changes: [],
        pending: false,
      });
    },
  );

  it("does not complete the upgrade when ambiguous include ownership blocks the config write", async () => {
    const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
    const { runWriteConfigHealth } =
      await import("../../../flows/doctor-health-contribution-runners.config.js");
    const configDir = path.dirname(state.configPath);
    await fs.writeFile(
      path.join(configDir, "telemetry-a.json"),
      JSON.stringify({ otel: { protocol: "grpc" } }),
    );
    await fs.writeFile(
      path.join(configDir, "telemetry-b.json"),
      JSON.stringify({ otel: { enabled: true } }),
    );
    await state.writeConfig({
      ...selectedPlan,
      diagnostics: { $include: ["./telemetry-a.json", "./telemetry-b.json"] },
    });
    const original = await fs.readFile(state.configPath, "utf8");

    const context = await prepareDoctorContext(state.configPath);
    expect(context.configResult.shouldWriteConfig).toBe(false);
    await runWriteConfigHealth(context, { runPostWriteRepairs: false });

    expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
    const retry = prepare(selectedPlan);
    expect(retry.pending).toBe(true);
    expect(retry.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
  });

  it("records completion when the operator accepts a preview without repair flags", async () => {
    const { loadAndMaybeMigrateDoctorConfig } = await import("../../doctor-config-flow.js");
    const { createDoctorPrompter } = await import("../../doctor-prompter.js");
    const { runWriteConfigHealth } =
      await import("../../../flows/doctor-health-contribution-runners.config.js");
    await state.writeConfig(selectedPlan);
    const options = { json: true };
    const messages: string[] = [];
    const runtime = {
      log: () => {},
      error: () => {},
      exit: (code: number) => {
        throw new Error(`Unexpected Doctor exit ${code}`);
      },
    };
    const prompter = createDoctorPrompter({ runtime, options });
    const configResult = await loadAndMaybeMigrateDoctorConfig({
      options,
      runtime,
      prompter,
      confirm: async ({ message }) => {
        messages.push(message);
        return true;
      },
    });
    expect(messages).toContain("Apply recommended config repairs now?");
    expect(configResult.shouldWriteConfig).toBe(true);
    const context = {
      runtime,
      options,
      prompter,
      configResult,
      cfg: configResult.cfg,
      cfgForPersistence: structuredClone(configResult.cfg),
      sourceConfigValid: configResult.sourceConfigValid,
      configPath: state.configPath,
      env: state.env,
      runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
      invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
    };

    await runWriteConfigHealth(context, { runPostWriteRepairs: false });

    const persisted: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(persisted.models?.providers?.["byteplus-plan"]).toEqual({ apiKey: byteplusRef });
    expect(prepare(selectedPlan)).toEqual({
      config: selectedPlan,
      changes: [],
      pending: false,
    });
  });
});
