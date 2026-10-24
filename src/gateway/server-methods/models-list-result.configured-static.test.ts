import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createOAuthRefreshCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import * as personalCatalogReads from "../../agents/auth-profiles/sqlite-read.js";
import { createPreparedAccountCatalogAccess } from "../../agents/prepared-model-runtime.catalog-auth.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  setUserProfileAuthLink,
} from "../../state/user-model-accounts.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { gatewayProfile } from "../server/client-fixtures.test-support.js";
import {
  catalogEntry,
  createModelsListTestContext,
  listModels,
  modelAuthStore,
  providerCatalogEntry,
  requestModelsList,
  withModelsListState,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

const luna = "gpt-5.6-luna";
const sol = "gpt-5.6-sol";
const sonnet = "claude-sonnet-4-6";

const withState = (run: (state: OpenClawTestState) => Promise<void>, withoutAuth = false) =>
  withModelsListState(run, withoutAuth ? { env: WITHOUT_OPENAI_ENV_AUTH } : {});
const configuredList = (state: OpenClawTestState, params: Parameters<typeof listModels>[0]) =>
  listModels({
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    view: "configured",
    preparedOnly: true,
    ...params,
  });
function agentConfig(
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"],
  rest: Omit<OpenClawConfig, "agents"> = {},
  entries?: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return { ...rest, agents: { defaults, ...(entries ? { entries } : {}) } };
}
function utilityConfig(
  provider: string,
  model: string,
  runtime: string,
  primary = model,
): OpenClawConfig {
  const ref = `${provider}/${model}`;
  return agentConfig(
    {
      model: `${provider}/${primary}`,
      utilityModel: ref,
      models: { [ref]: { agentRuntime: { id: runtime } } },
    },
    {
      models: {
        providers: {
          [provider]: {
            api: provider === "openai" ? "openai-responses" : "openai-completions",
            baseUrl: `https://${provider === "openai" ? "api.openai.com" : "custom.example"}/v1`,
            apiKey: "synthetic-key",
            models: [],
          },
        },
      },
    },
  );
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("keeps the utility runtime on the prepared catalog's plugin generation", async () => {
  await withState(async (state) => {
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
    const cfg = utilityConfig("custom", "small", "utility-runtime", "primary");
    const result = await withPluginRuntimeRegistryScope(ambientRegistry, () =>
      configuredList(state, {
        cfg,
        pluginRegistry: preparedRegistry,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "custom", providers: ["custom"], syntheticAuthRefs: ["custom"] }],
        }),
        catalog: ["primary", "small"].map((id) => providerCatalogEntry("custom", id)),
      }),
    );

    expect(result.defaultModels?.utilityRuntime).toEqual({
      id: "utility-runtime",
      kind: "harness",
      label: "Prepared Runtime",
    });
  });
});

it("projects utility runtimes for API, subscription, unavailable, and disabled selections", async () => {
  await withState(async (state) => {
    const cfg = utilityConfig("openai", "gpt-5.5", "codex");
    cfg.plugins = { allow: ["codex"], entries: { codex: { enabled: true } } };
    setRuntimeConfigSnapshot(cfg);
    const pluginRegistry = loadOpenClawPlugins({
      config: cfg,
      onlyPluginIds: ["codex"],
      activate: false,
      cache: false,
    });
    const plugin = pluginRegistry.plugins.find((entry) => entry.id === "codex");
    expect(plugin?.status, plugin?.error).toBe("loaded");
    const result = await withPluginRuntimeRegistryScope(pluginRegistry, () =>
      configuredList(state, {
        cfg,
        pluginRegistry,
        catalog: [catalogEntry("gpt-5.5", "openai-responses")],
      }),
    );
    expect(result.defaultModels).toEqual({
      automaticUtilityModel: `openai/${luna}`,
      utilityRuntime: { id: "openclaw", kind: "api", label: "OpenClaw Default" },
    });
    const pinnedConfig = agentConfig(
      { ...cfg.agents?.defaults, utilityModel: "openai/gpt-5.5@openai:utility" },
      { ...cfg, models: undefined },
    );
    const subscription = modelAuthStore({
      "openai:utility": createOAuthRefreshCredential({
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 3_600_000,
      }),
    });
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
      const projected = await configuredList(state, {
        cfg:
          name === "disabled"
            ? agentConfig({ ...pinnedConfig.agents?.defaults, utilityModel: "" }, pinnedConfig)
            : pinnedConfig,
        pluginRegistry,
        preparedAuthStore: authStore,
        catalog: [catalogEntry("gpt-5.5", "openai-chatgpt-responses")],
      });
      expect(projected.defaultModels, name).toEqual({
        automaticUtilityModel: `openai/${luna}`,
        ...(expected ? { utilityRuntime: expected } : {}),
      });
    }
  }, true);
});

it.each(["small", undefined])(
  "previews global automatic utility routing with provider default %s",
  async (defaultUtilityModel) => {
    await withState(async (state) => {
      const cfg = agentConfig(
        {
          model: "global-primary@work",
          models: { "custom/primary": { alias: "global-primary" } },
        },
        {},
        {
          worker: {
            model: "other/primary@personal",
            utilityModel: "other/explicit",
            models: { "other/primary": { alias: "global-primary" } },
          },
        },
      );
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
        catalog: ["custom", "other"].map((provider) => providerCatalogEntry(provider, "primary")),
        metadataSnapshot,
      });
      const respond = await requestModelsList(context, {
        agentId: "worker",
        view: "configured",
        preparedOnly: true,
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
    });
  },
);

it("projects personal-only models for the authenticated requester without publishing shared auth", async () => {
  await withState(async (state) => {
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const discover = vi.fn(async () => {
      throw new Error("Ordinary model reads must not discover account models");
    });
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "openai",
      source: "test",
      provider: { id: "openai", label: "OpenAI", auth: [], catalog: { run: discover } },
    });
    const context = createModelsListTestContext({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      cfg: { agents: { defaults: { model: { primary: "test/default" } } } },
      catalog: [],
      staticEntries: [catalogEntry(luna, "openai-chatgpt-responses")],
      pluginRegistry,
    });
    const published = await readPreparedCatalog(context, "main");
    const owner = {
      ...published!,
      accountCatalog: createPreparedAccountCatalogAccess(() => true),
    };
    registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
      readPrepared: async () => owner,
      loadDeferred: async () => owner,
    });
    const read = async (profileId?: string, expectedSuccess = true) => {
      const respond = await requestModelsList(
        context,
        { agentId: "main", view: "configured", includeDefaultModels: false },
        profileId
          ? {
              connect: {
                minProtocol: 4,
                maxProtocol: 4,
                client: { id: "cli", version: "test", platform: "test", mode: "cli" },
                caps: [],
              },
              authenticatedUserProfile: gatewayProfile(profileId),
            }
          : null,
      );
      expect(respond.mock.calls[0]?.[0]).toBe(expectedSuccess);
      if (!expectedSuccess) {
        expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
      }
      return respond.mock.calls[0]?.[1];
    };
    const shared = await read();
    expect(shared).toEqual({ models: [] });
    const unconfiguredPersonal = {
      models: [],
      accountSelection: { kind: "automatic", label: "Automatic account selection" },
    };
    expect(await read(alice.id)).toEqual(unconfiguredPersonal);
    const { authProfileId } = connectUserModelAccount({
      ownerProfileId: alice.id,
      credential: createOAuthRefreshCredential({
        access: "synthetic-personal-access",
        refresh: "synthetic-personal-refresh",
        expires: Date.now() + 600_000,
      }),
      assertCurrent() {},
    });

    const sql = observeHostDataSql();
    let connected: Awaited<ReturnType<typeof read>>;
    try {
      connected = await read(alice.id);
    } finally {
      sql.restore();
    }
    expect(sql.queries.filter((query) => /\bsecret_store_entries\b/i.test(query))).toEqual([]);
    expect(connected).toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: luna, available: true })]),
    });
    expect(await read(bob.id)).toEqual(unconfiguredPersonal);
    expect(await read()).toEqual(shared);

    const readPersonal = personalCatalogReads.readPersonalCatalogProfiles;
    const interruptedRead = vi
      .spyOn(personalCatalogReads, "readPersonalCatalogProfiles")
      .mockImplementationOnce(async (...args) => {
        const result = await readPersonal(...args);
        clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });
        return result;
      });
    try {
      await read(alice.id, false);
    } finally {
      interruptedRead.mockRestore();
    }
    setUserProfileAuthLink({ profileId: alice.id, provider: "openai", authProfileId });

    const merged = ensureProfileForEmail("alice-new@example.test");
    linkEmail("alice@example.test", merged.id);
    expect(await read(alice.id)).toEqual(connected);
    clearUserProfileAuthLink({ profileId: merged.id, provider: "openai" });
    expect(await read(alice.id)).toEqual(unconfiguredPersonal);
    expect(discover.mock.calls.length).toBe(0);
  }, true);
});

it.each([true, false])(
  "uses the correct configured catalog past the browse deadline (refresh=%s)",
  async (refresh) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const catalog = ["Luna", "Sol"].map((name) => ({
      id: `gpt-5.6-${name.toLowerCase()}`,
      provider: "openai",
      api: "openai-responses" as const,
      name: `${refresh ? "Refreshed" : "Published"} ${name}`,
    }));
    const config = agentConfig({
      model: { primary: `openai/${luna}` },
      models: { [`openai/${luna}`]: {}, [`openai/${sol}`]: {} },
    });

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
      { id: luna, name: `${refresh ? "Refreshed" : "Published"} Luna` },
      { id: sol, name: `${refresh ? "Refreshed" : "Published"} Sol` },
    ]);
  },
);

it("projects agent aliases onto inherited default and fallback catalog rows", async () => {
  await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
    const cfg = agentConfig(
      {
        model: { primary: luna, fallbacks: [sonnet] },
        models: {
          [`openai/${luna}`]: { alias: "global-luna" },
          [`anthropic/${sonnet}`]: { alias: "global-sonnet" },
        },
      },
      {},
      {
        main: {},
        worker: {
          models: {
            [`openai/${luna}`]: { agentRuntime: { id: "codex" } },
            [`anthropic/${sonnet}`]: { alias: "worker-sonnet" },
          },
        },
      },
    );

    const result = await listModels({
      agentId: "worker",
      cfg,
      view: "configured",
      catalog: [catalogEntry(luna, "openai-responses"), providerCatalogEntry("anthropic", sonnet)],
    });

    const projected = Object.fromEntries(
      result.models.map((model) => [model.id, { alias: model.alias, tags: model.tags }]),
    );
    expect(projected).toMatchObject({
      [luna]: { alias: "global-luna", tags: ["default", "configured"] },
      [sonnet]: { alias: "worker-sonnet", tags: ["fallback#1", "configured"] },
    });
  });
});
