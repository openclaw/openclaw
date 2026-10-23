import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential, AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { withAuthProfileTestState } from "../../agents/auth-profiles/profile-mutations.test-support.js";
import { removeAuthProfilesAcrossOwnerStores } from "../../agents/auth-profiles/profiles.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../../agents/auth-profiles/store-runtime.js";
import * as catalogCredentials from "../../agents/plugin-model-catalog-credentials.js";
import * as catalogs from "../../agents/plugin-model-catalog.js";
import { registerModelsCli } from "../../cli/models-cli.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import type { RespondFn } from "../../gateway/server-methods/types.js";
import { defaultRuntime } from "../../runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createCapturingTestRuntime } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn<() => AuthProfileStore>(),
  removeAuthProfilesAcrossOwnerStores: vi.fn<typeof removeAuthProfilesAcrossOwnerStores>(),
  loadModelsConfig: vi.fn(),
  updateConfig: vi.fn(),
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  const loadStore = mocks.ensureAuthProfileStoreWithoutExternalProfiles;
  const loadStoreAsync = async () => loadStore();
  return {
    ...actual,
    ensureAuthProfileStoreWithoutExternalProfiles: loadStore,
    ensureAuthProfileStoreWithoutExternalProfilesAsync: loadStoreAsync,
    loadAuthProfileStoreWithoutExternalProfiles: loadStore,
    loadAuthProfileStoreWithoutExternalProfilesAsync: loadStoreAsync,
    removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
  };
});

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    resolveModelsTargetAgent: (_cfg: OpenClawConfig, rawAgentId?: string) => ({
      agentId: rawAgentId ?? "main",
      agentDir: `/tmp/agent-${rawAgentId ?? "main"}`,
    }),
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

vi.mock("../../gateway/server-methods/models-auth-refresh.js", () => ({
  modelsAuthRefreshHandlers: {},
}));

vi.mock("../../gateway/model-auth-refresh.js", () => ({
  refreshModelAuthStateAfterMutation: vi.fn(async () => undefined),
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ confirm: mocks.confirm }),
}));

const { modelsAuthLogoutCommand } = await import("./auth-logout.js");

async function runRegisteredLogout(profileId: string): Promise<void> {
  const errors: string[] = [];
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation((message) => {
    errors.push(String(message));
  });
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
    throw new Error(errors.join("\n"));
  });
  try {
    const program = new Command().exitOverride();
    registerModelsCli(program);
    await program.parseAsync(["models", "auth", "logout", profileId, "--yes"], { from: "user" });
  } finally {
    error.mockRestore();
    exit.mockRestore();
  }
}

async function dispatchAuthLogout(
  cfg: OpenClawConfig,
  selection: { profileIds?: string[]; credentialType?: "api_key" },
): Promise<void> {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: crypto.randomUUID(),
      method: "models.authLogout",
      params: { provider: "openai", agentId: "main", ...selection },
    },
    respond,
    client: {
      connId: crypto.randomUUID(),
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      },
    },
    isWebchatConnect: () => false,
    context: createDirectChatContext({
      getRuntimeConfig: () => ({ ...cfg, agents: { entries: { main: {} } } }),
    }),
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, payload, error] = expectDefined(respond.mock.calls[0], "Gateway logout response");
  if (!ok) {
    throw new Error(expectDefined(error, "Gateway logout error").message);
  }
  expect(payload).toHaveProperty(
    "warning",
    "Credentials were removed, but the Gateway has not confirmed applying the change. Run `openclaw gateway restart` to apply it.",
  );
}

type ConfigMutator = (
  current: OpenClawConfig,
  context: { runtimeConfig: OpenClawConfig },
) => OpenClawConfig | Promise<OpenClawConfig>;
const createRuntime = () => createCapturingTestRuntime().runtime;

function trackConfig(initial: OpenClawConfig, afterWrite?: (cfg: OpenClawConfig) => void) {
  let current = initial;
  mocks.loadModelsConfig.mockImplementation(async () => current);
  mocks.updateConfig.mockImplementation(async (mutate: ConfigMutator) => {
    current = await mutate(current, { runtimeConfig: current });
    afterWrite?.(current);
    return current;
  });
  return () => current;
}

function authConfig(
  profiles: NonNullable<OpenClawConfig["auth"]>["profiles"],
  apiKey?: string,
): OpenClawConfig {
  const cfg: OpenClawConfig = {
    auth: { profiles, order: { openai: Object.keys(profiles ?? {}) } },
  };
  if (apiKey) {
    cfg.models = {
      providers: { openai: { baseUrl: "https://example.test/v1", models: [], apiKey } },
    };
  }
  return cfg;
}

function usePersistedStore(agentDir: string) {
  mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockImplementation(() =>
    loadAuthProfileStoreWithoutExternalProfiles(agentDir),
  );
  mocks.removeAuthProfilesAcrossOwnerStores.mockImplementation((params) =>
    removeAuthProfilesAcrossOwnerStores({ ...params, agentDir }),
  );
}

function catalogDatabase(agentDir: string, main: string) {
  return openOpenClawAgentDatabase({
    agentId: agentDir === main ? "main" : "child",
    path: resolveAuthProfileDatabasePath(agentDir),
  }).db;
}

async function withStdinIsTty<T>(isTTY: boolean, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: isTTY });
  try {
    return await run();
  } finally {
    if (previous) {
      Object.defineProperty(process.stdin, "isTTY", previous);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  }
}

describe("models auth logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeAuthProfilesAcrossOwnerStores.mockImplementation(async (params) => {
      await params.beforeRemove?.(params.profileIds, []);
      return true;
    });
    mocks.confirm.mockResolvedValue(true);
    mocks.updateConfig.mockResolvedValue({});
    mocks.loadModelsConfig.mockResolvedValue({});
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
      createAuthProfileStoreFixture({
        "openai:manual": createOAuthRefreshCredential({ expires: 1_000_000 }),
      }),
    );
  });

  it.each([
    ["openai:missing", 'Auth profile "openai:missing" not found for agent "main"'],
    ["  ", "Missing profile id"],
  ])("refuses removal for profile %j", async (profileId, expected) => {
    await expect(
      modelsAuthLogoutCommand({ profileId, yes: true }, createRuntime()),
    ).rejects.toThrow(expected);
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });

  it("removes cached credential copies across agents without disabling another account", () =>
    withAuthProfileTestState("openclaw-auth-catalog-logout-", async ({ agentDirFor }) => {
      const main = agentDirFor("main");
      const child = agentDirFor("child");
      const selected = createApiKeyCredential("fixture", "selected-secret");
      const survivor = createApiKeyCredential("fixture", "surviving-secret");
      saveAuthProfileStore(createAuthProfileStoreFixture({ selected, survivor }), main);
      usePersistedStore(main);
      const retainedProvider = {
        api: "openai-completions",
        headers: { "X-Version": "1" },
        models: [
          { id: "selected-model", headers: {} },
          { id: "surviving-model", apiKey: survivor.key },
        ],
      };
      const catalog = {
        generatedBy: "openclaw-plugin-model-catalog-v1",
        providers: {
          fixture: {
            ...retainedProvider,
            apiKey: selected.key,
            headers: { ...retainedProvider.headers, Authorization: `Bearer ${selected.key}` },
            models: [
              { id: "selected-model", headers: { "X-Api-Key": selected.key } },
              retainedProvider.models[1],
            ],
          },
        },
      };
      const unusableProviders = [
        [selected.key],
        { apiKey: { value: selected.key } },
        { headers: [selected.key] },
        { headers: { Authorization: { token: selected.key } } },
        { models: { Authorization: selected.key } },
        { models: [selected.key] },
        { models: [{ id: "array-header", headers: { Authorization: [selected.key] } }] },
        { models: [{ id: "string-headers", headers: selected.key }] },
      ];
      const unusableCatalogs = [
        '{"apiKey":"selected-secret"',
        ...unusableProviders.map((fixture) =>
          JSON.stringify({ ...catalog, providers: { fixture } }),
        ),
      ];
      const scopes = ["plugin-model-catalog-v1", "plugin-model-catalog-migration-v1"];
      for (const agentDir of [main, child]) {
        await catalogs.replacePersistedPluginModelCatalogs({
          agentDir,
          pluginCatalogWrites: {
            [catalogs.encodePluginModelCatalogRelativePath("fixture")]: JSON.stringify(catalog),
          },
        });
        const db = catalogDatabase(agentDir, main);
        const insert = db.prepare(
          "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, 1)",
        );
        insert.run("plugin-model-catalog-migration-v1", "fixture", JSON.stringify(catalog));
        for (const scope of scopes) {
          for (const [index, contents] of unusableCatalogs.entries()) {
            insert.run(scope, `broken-${index}`, contents);
          }
        }
        insert.run("unrelated-cache", "keep", '{"value":"retained"}');
      }

      await runRegisteredLogout("selected");

      expect(loadAuthProfileStoreWithoutExternalProfiles(main).profiles).toEqual({ survivor });
      for (const agentDir of [main, child]) {
        const db = catalogDatabase(agentDir, main);
        for (const scope of scopes) {
          const rows = db
            .prepare("SELECT key, value_json FROM cache_entries WHERE scope = ?")
            .all(scope) as Array<{ key: string; value_json: string }>;
          expect(rows.map((row) => row.key)).toEqual(["fixture"]);
          expect(JSON.parse(rows[0]!.value_json)).toEqual({
            ...catalog,
            providers: { fixture: retainedProvider },
          });
        }
        expect(
          db.prepare("SELECT value_json FROM cache_entries WHERE scope = ?").get("unrelated-cache"),
        ).toEqual({ value_json: '{"value":"retained"}' });
      }
    }));

  it("removes config before credentials, restores both after cleanup fails, then permits retry", () =>
    withAuthProfileTestState("openclaw-logout-final-scrub-", async ({ agentDir }) => {
      const profileId = "openai:manual";
      const credential = createApiKeyCredential("openai", "retryable-secret");
      saveAuthProfileStore(createAuthProfileStoreFixture({ [profileId]: credential }), agentDir);
      const originalConfig = authConfig({ [profileId]: { provider: "openai", mode: "api_key" } });
      const readProfile = () =>
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId];
      const beforeDelete = vi.fn(() => expect(readProfile()).toEqual(credential));
      const liveConfig = trackConfig(structuredClone(originalConfig), (next) => {
        if (!next.auth?.profiles?.[profileId]) {
          expect(next.auth).toEqual({ profiles: {} });
          beforeDelete();
        }
      });
      usePersistedStore(agentDir);
      const scrub = catalogCredentials.removePersistedPluginModelCatalogCredentials;
      let calls = 0;
      const cleanup = vi
        .spyOn(catalogCredentials, "removePersistedPluginModelCatalogCredentials")
        .mockImplementation(async (params) => {
          calls += 1;
          if (calls === 1) {
            expect(readProfile()).toBeUndefined();
            throw new Error("synthetic final catalog write failure");
          }
          await scrub(params);
        });
      try {
        await expect(runRegisteredLogout(profileId)).rejects.toThrow(
          "saved credentials were restored",
        );
        expect({ profile: readProfile(), auth: liveConfig().auth }).toEqual({
          profile: credential,
          auth: originalConfig.auth,
        });
        await runRegisteredLogout(profileId);
        expect(readProfile()).toBeUndefined();
        expect(liveConfig().auth?.profiles?.[profileId]).toBeUndefined();
        expect(liveConfig().auth?.order?.openai).toBeUndefined();
        expect(beforeDelete).toHaveBeenCalledTimes(2);
      } finally {
        cleanup.mockRestore();
      }
    }));

  it.each(["profiles", "api_key"] as const)(
    "reconciles partial %s removal and retry without losing other bindings",
    async (mode) => {
      const allProfiles = mode === "profiles";
      const keyId = "openai:key";
      const otherId = "openai:other";
      const key: AuthProfileCredential = createApiKeyCredential("openai", "synthetic-key");
      const other: AuthProfileCredential = allProfiles
        ? createApiKeyCredential("openai", "synthetic-survivor")
        : { type: "token", provider: "openai", token: "synthetic-token" };
      const keyConfig = { provider: "openai", mode: "api_key" as const };
      const otherConfig = { provider: "openai", mode: other.type };
      const profiles = { [keyId]: keyConfig, [otherId]: otherConfig };
      const liveConfig = trackConfig(authConfig(profiles, otherId));
      const setStore = (entries: AuthProfileStore["profiles"]) =>
        mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
          createAuthProfileStoreFixture(entries),
        );
      setStore({ [keyId]: key, [otherId]: other });
      mocks.removeAuthProfilesAcrossOwnerStores
        .mockReset()
        .mockImplementationOnce(async (params) => {
          await params.beforeRemove?.(params.profileIds, []);
          if (allProfiles) {
            setStore({ [otherId]: other });
          }
          await params.onIncomplete?.(
            new Map(allProfiles ? [[otherId, other]] : [[keyId, key]]),
            [],
          );
          return false;
        })
        .mockImplementationOnce(async (params) => {
          await params.beforeRemove?.(params.profileIds, []);
          setStore(allProfiles ? {} : { [otherId]: other });
          return true;
        });
      const selection = allProfiles
        ? { profileIds: [keyId, otherId] }
        : { credentialType: "api_key" as const };
      await expect(dispatchAuthLogout(liveConfig(), selection)).rejects.toThrow(
        "could not be removed",
      );
      expect(liveConfig().auth).toEqual({
        profiles: allProfiles ? { [otherId]: otherConfig } : profiles,
        order: { openai: allProfiles ? [otherId] : [keyId, otherId] },
      });
      expect(liveConfig().models?.providers?.openai?.apiKey).toBe(otherId);
      await dispatchAuthLogout(liveConfig(), allProfiles ? { profileIds: [otherId] } : selection);
      expect(liveConfig().auth).toEqual({
        profiles: allProfiles ? {} : { [otherId]: otherConfig },
        ...(allProfiles ? {} : { order: { openai: [otherId] } }),
      });
      expect(liveConfig().models?.providers?.openai?.apiKey).toBe(
        allProfiles ? undefined : otherId,
      );
    },
  );

  it.each([true, false])("keeps unconfirmed credentials with stdin TTY=%s", async (isTTY) => {
    mocks.confirm.mockResolvedValue(false);
    await withStdinIsTty(isTTY, async () => {
      const { runtime, logs } = createCapturingTestRuntime();
      const removal = modelsAuthLogoutCommand({ profileId: "openai:manual" }, runtime);
      if (isTTY) {
        await removal;
        expect(logs).toContain("Cancelled.");
      } else {
        await expect(removal).rejects.toThrow("Pass --yes to remove it non-interactively.");
      }
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    });
  });
});
