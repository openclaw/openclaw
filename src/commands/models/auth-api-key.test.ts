import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveApiKeyForProfile,
  replaceRuntimeAuthProfileStoreSnapshots,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { saveModelProviderApiKey } from "./auth-api-key.js";
import { removeModelAuthCredentials } from "./auth-logout.js";
import * as configWriter from "./shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const connection = { baseUrl: "http://127.0.0.1:9/v1", models: [] };
let stateDir: string;
const agentDir = (id: string) => path.join(stateDir, "agents", id, "agent");
const configPath = () => path.join(stateDir, "openclaw.json");
const writeConfig = (config: OpenClawConfig) =>
  fs.writeFileSync(configPath(), JSON.stringify(config));
const save = (apiKey = "synthetic-new-key", profileId?: string) =>
  saveModelProviderApiKey({ provider: "sample", apiKey, profileId, agentDir: agentDir("writer") });

async function readConfig() {
  return (await configWriter.loadValidConfigSnapshotOrThrow()).runtimeConfig;
}

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-shared-api-key-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath());
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  vi.stubEnv("OPENCLAW_OAUTH_DIR", undefined);
  writeConfig({ plugins: { allow: [] } });
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("shared API-key editing and removal", () => {
  it("replaces a configured shared key, preserving metadata, defaults and cross-agent resolution", async () => {
    const profileId = "sample:work";
    await upsertAuthProfileWithLockOrThrow({
      profileId,
      credential: {
        type: "api_key",
        provider: "sample",
        key: "old-key",
        copyToAgents: false,
        displayName: "Stored account",
        email: "stored@example.test",
      },
    });
    const configuredProfile = {
      provider: "sample",
      mode: "api_key" as const,
      displayName: "Work",
      email: "work@example.test",
    };
    writeConfig({
      plugins: { allow: [] },
      agents: { defaults: { model: "kept/model" } },
      auth: { profiles: { [profileId]: configuredProfile } },
      models: { providers: { sample: { ...connection, apiKey: profileId } } },
    });
    expect(await save()).toBe(profileId);
    const config = await readConfig();
    expect(config.agents?.defaults?.model).toBe("kept/model");
    expect(config.models?.providers?.sample).toEqual({ ...connection, apiKey: profileId });
    expect(config.auth?.profiles?.[profileId]).toEqual(configuredProfile);
    expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toMatchObject({
      key: "synthetic-new-key",
      copyToAgents: false,
      email: "stored@example.test",
      displayName: "Stored account",
    });
    const reader = agentDir("reader");
    await expect(
      resolveApiKeyForProfile({
        cfg: config,
        store: ensureAuthProfileStoreWithoutExternalProfiles(reader),
        profileId,
        agentDir: reader,
      }),
    ).resolves.toMatchObject({ apiKey: "synthetic-new-key" });
  });

  it("uses stored key order and preserves the unselected sibling", async () => {
    for (const [profileId, key] of [
      ["sample:work", "old-work"],
      ["sample:backup", "kept-backup"],
    ] as const) {
      await upsertAuthProfileWithLockOrThrow({
        agentDir: agentDir("writer"),
        profileId,
        credential: { type: "api_key", provider: "sample", key },
      });
    }
    await setAuthProfileOrder({
      agentDir: agentDir("writer"),
      provider: "sample",
      order: ["sample:work", "sample:backup"],
    });
    expect(await save()).toBe("sample:work");
    const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir("writer"));
    expect(store.profiles["sample:work"]).toMatchObject({ key: "synthetic-new-key" });
    expect(store.profiles["sample:backup"]).toMatchObject({ key: "kept-backup" });
    expect(store.order?.sample).toEqual(["sample:work", "sample:backup"]);
    expect((await readConfig()).models).toBeUndefined();
  });

  it.each(["main", "reader"])(
    "removes a shared bound key through %s and retains its sibling and model settings",
    async (caller) => {
      await upsertAuthProfileWithLockOrThrow({
        profileId: "sample:bound",
        credential: { type: "api_key", provider: "sample", key: "removed" },
      });
      await upsertAuthProfileWithLockOrThrow({
        profileId: "sample:backup",
        credential: { type: "api_key", provider: "sample", key: "kept" },
      });
      writeConfig({
        plugins: { allow: [] },
        agents: { defaults: { model: "sample/model" } },
        auth: {
          profiles: { "sample:bound": { provider: "sample", mode: "api_key" } },
          order: { sample: ["sample:bound"], other: [] },
        },
        models: { providers: { sample: { ...connection, apiKey: "sample:bound" } } },
      });
      await removeModelAuthCredentials({
        cfg: await readConfig(),
        agentDir: agentDir(caller),
        profileIds: ["sample:bound"],
      });
      const config = await readConfig();
      expect(config.auth).toEqual({ profiles: {}, order: { other: [] } });
      expect(config.models?.providers?.sample).toEqual(connection);
      expect(config.agents?.defaults?.model).toBe("sample/model");
      const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir(caller));
      expect(store.profiles["sample:bound"]).toBeUndefined();
      expect(store.profiles["sample:backup"]).toMatchObject({ key: "kept" });
    },
  );

  it("preserves an externally managed key and its binding when removing inline keys", async () => {
    const external = {
      type: "api_key" as const,
      provider: "sample",
      keyRef: { source: "env" as const, provider: "default", id: "AUTH_B_EXTERNAL" },
    };
    await upsertAuthProfileWithLockOrThrow({
      agentDir: agentDir("writer"),
      profileId: "sample:external",
      credential: external,
    });
    await upsertAuthProfileWithLockOrThrow({
      agentDir: agentDir("writer"),
      profileId: "sample:inline",
      credential: { type: "api_key", provider: "sample", key: "removed" },
    });
    writeConfig({
      models: { providers: { sample: { ...connection, apiKey: "sample:external" } } },
    });
    await removeModelAuthCredentials({
      cfg: await readConfig(),
      agentDir: agentDir("writer"),
      profileIds: ["sample:inline"],
      apiKeyProvider: "sample",
    });
    expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles).toEqual({
      "sample:external": external,
    });
    expect((await readConfig()).models?.providers?.sample?.apiKey).toBe("sample:external");
  });

  it("preserves agent overrides when a global key would shadow them", async () => {
    await upsertAuthProfileWithLockOrThrow({
      agentDir: agentDir("reader"),
      profileId: "sample:manual",
      credential: { type: "api_key", provider: "sample", key: "kept-local" },
    });
    writeConfig({ models: { providers: { sample: { ...connection, apiKey: "old-inline" } } } });
    const before = fs.readFileSync(configPath(), "utf8");
    await expect(save()).rejects.toThrow("An agent already overrides this shared key");
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(
      loadPersistedAuthProfileStore(agentDir("reader"))?.profiles["sample:manual"],
    ).toMatchObject({ key: "kept-local" });
  });

  it.each([
    { type: "api_key", provider: "other", key: "kept" },
    { type: "token", provider: "sample", token: "kept" },
  ] satisfies AuthProfileCredential[])(
    "does not replace an incompatible $type credential",
    async (credential) => {
      await upsertAuthProfileWithLockOrThrow({
        agentDir: agentDir("writer"),
        profileId: "sample:manual",
        credential,
      });
      await expect(save()).rejects.toThrow("belongs to another sign-in");
      expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:manual"]).toEqual(
        credential,
      );
    },
  );

  it.each([
    {
      profileId: "sample:external",
      config: {
        models: {
          providers: { sample: { ...connection, apiKey: "sample:external" } },
        },
      },
    },
    {
      profileId: "sample:manual",
      config: {
        models: {
          providers: { sample: connection },
        },
      },
    },
  ])("preserves reference-backed profile $profileId during replacement", async (fixture) => {
    const credential: AuthProfileCredential = {
      type: "api_key",
      provider: "sample",
      keyRef: { source: "env", provider: "default", id: "SAMPLE_API_KEY" },
      copyToAgents: false,
    };
    await upsertAuthProfileWithLockOrThrow({
      profileId: fixture.profileId,
      credential,
    });
    writeConfig(fixture.config);

    await expect(save()).rejects.toThrow("uses an external secret reference");

    expect(loadPersistedAuthProfileStore()?.profiles[fixture.profileId]).toEqual(credential);
    expect((await readConfig()).models).toEqual(fixture.config.models);
  });

  it("reports saved key material separately from failed config application and redacts it", async () => {
    vi.spyOn(configWriter, "updateConfig").mockRejectedValueOnce(new Error("config write failed"));
    await expect(save("ordinary-fixture\r\n-key-8304")).rejects.toThrow(
      "API key saved, but provider settings could not be applied",
    );
    expect(
      loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:manual"],
    ).toMatchObject({ key: "ordinary-fixture-key-8304" });
    expect(redactSensitiveText("error: ordinary-fixture-key-8304")).not.toContain(
      "ordinary-fixture-key-8304",
    );
  });
  it.each([
    { type: "token", provider: "sample", token: "kept-replacement" },
    {
      type: "api_key",
      provider: "sample",
      keyRef: { source: "env", provider: "default", id: "AUTH_B_REPLACEMENT" },
    },
  ] satisfies AuthProfileCredential[])(
    "preserves a concurrent $type replacement during API-key removal",
    async (replacement) => {
      const profileId = "sample:race";
      await upsertAuthProfileWithLockOrThrow({
        agentDir: agentDir("writer"),
        profileId,
        credential: { type: "api_key", provider: "sample", key: "old-key" },
      });
      writeConfig({ models: { providers: { sample: { ...connection, apiKey: profileId } } } });
      const config = await readConfig();
      const updateConfig = configWriter.updateConfig;
      vi.spyOn(configWriter, "updateConfig").mockImplementationOnce(async (mutator) => {
        await upsertAuthProfileWithLockOrThrow({
          agentDir: agentDir("writer"),
          profileId,
          credential: replacement,
        });
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir: agentDir("writer"),
            store: {
              version: 1,
              profiles: { [profileId]: { type: "api_key", provider: "sample", key: "stale-key" } },
            },
          },
        ]);
        return updateConfig(mutator);
      });
      await expect(
        removeModelAuthCredentials({
          cfg: config,
          agentDir: agentDir("writer"),
          profileIds: [profileId],
          apiKeyProvider: "sample",
        }),
      ).rejects.toThrow("changed");
      expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles[profileId]).toEqual(
        replacement,
      );
      expect((await readConfig()).models?.providers?.sample?.apiKey).toBe(profileId);
    },
  );

  it("preserves a configured agent-local key instead of rebinding it to a new shared key", async () => {
    await upsertAuthProfileWithLockOrThrow({
      agentDir: agentDir("writer"),
      profileId: "sample:local",
      credential: { type: "api_key", provider: "sample", key: "kept-local", copyToAgents: false },
    });
    writeConfig({ models: { providers: { sample: { ...connection, apiKey: "sample:local" } } } });
    await expect(save()).rejects.toThrow("An agent already overrides this shared key");
    expect(
      loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:local"],
    ).toMatchObject({ key: "kept-local", copyToAgents: false });
    expect((await readConfig()).models?.providers?.sample?.apiKey).toBe("sample:local");
  });

  it("retains the credential when config reference cleanup fails", async () => {
    const profileId = await save();
    vi.spyOn(configWriter, "updateConfig").mockRejectedValueOnce(new Error("config write failed"));
    await expect(
      removeModelAuthCredentials({
        cfg: await readConfig(),
        agentDir: agentDir("writer"),
        profileIds: [profileId],
      }),
    ).rejects.toThrow("config write failed");
    expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles[profileId]).toMatchObject({
      key: "synthetic-new-key",
    });
  });

  it("cleans references for every profile in the owner's full-provider removal plan", async () => {
    for (const profileId of ["sample:old", "sample:new"]) {
      await upsertAuthProfileWithLockOrThrow({
        agentDir: agentDir("writer"),
        profileId,
        credential: { type: "api_key", provider: "sample", key: "removed-key" },
      });
    }
    writeConfig({ models: { providers: { sample: { ...connection, apiKey: "sample:new" } } } });
    await removeModelAuthCredentials({
      cfg: await readConfig(),
      agentDir: agentDir("writer"),
      profileIds: ["sample:old"],
      provider: "sample",
    });
    expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles).toEqual({});
    expect((await readConfig()).models?.providers?.sample?.apiKey).toBeUndefined();
  });

  it("preserves a new profile and binding added after full-provider removal was planned", async () => {
    await save("old-key", "sample:old");
    const config = await readConfig();
    const updateConfig = configWriter.updateConfig;
    vi.spyOn(configWriter, "updateConfig").mockImplementationOnce(async (mutator) => {
      await upsertAuthProfileWithLockOrThrow({
        agentDir: agentDir("writer"),
        profileId: "sample:new",
        credential: { type: "token", provider: "sample", token: "kept-new-token" },
      });
      writeConfig({ models: { providers: { sample: { ...connection, apiKey: "sample:new" } } } });
      return updateConfig(mutator);
    });
    await expect(
      removeModelAuthCredentials({
        cfg: config,
        agentDir: agentDir("writer"),
        profileIds: ["sample:old"],
        provider: "sample",
      }),
    ).rejects.toThrow("could not be removed");
    expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:new"]).toMatchObject(
      { token: "kept-new-token" },
    );
    expect((await readConfig()).models?.providers?.sample?.apiKey).toBe("sample:new");
  });

  it.each([
    { name: "API-key-only", selection: { apiKeyProvider: "sample" } },
    { name: "full-provider", selection: { provider: "sample" } },
  ])(
    "restores config after a concurrent same-profile replacement rejects $name removal",
    async ({ selection }) => {
      const profileId = "sample:race";
      await upsertAuthProfileWithLockOrThrow({
        agentDir: agentDir("writer"),
        profileId,
        credential: { type: "api_key", provider: "sample", key: "old-key" },
      });
      writeConfig({
        auth: {
          profiles: { [profileId]: { provider: "sample", mode: "api_key" } },
          order: { sample: [profileId] },
        },
        models: { providers: { sample: { ...connection, apiKey: profileId } } },
      });
      const config = await readConfig();
      const updateConfig = configWriter.updateConfig;
      vi.spyOn(configWriter, "updateConfig").mockImplementationOnce(async (mutator) => {
        await upsertAuthProfileWithLockOrThrow({
          agentDir: agentDir("writer"),
          profileId,
          credential: { type: "api_key", provider: "sample", key: "replacement-key" },
        });
        return updateConfig(mutator);
      });

      await expect(
        removeModelAuthCredentials({
          cfg: config,
          agentDir: agentDir("writer"),
          profileIds: [profileId],
          ...selection,
        }),
      ).rejects.toThrow("could not be removed");

      expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles[profileId]).toMatchObject({
        key: "replacement-key",
      });
      const restored = await readConfig();
      expect(restored.auth?.profiles?.[profileId]).toEqual({
        provider: "sample",
        mode: "api_key",
      });
      expect(restored.auth?.order?.sample).toEqual([profileId]);
      expect(restored.models?.providers?.sample?.apiKey).toBe(profileId);
    },
  );

  it("does not use a stale runtime key snapshot to authorize removal of a durable token", async () => {
    const profileId = "sample:stale";
    const replacement: AuthProfileCredential = {
      type: "token",
      provider: "sample",
      token: "kept-durable-token",
    };
    await upsertAuthProfileWithLockOrThrow({
      agentDir: agentDir("writer"),
      profileId,
      credential: replacement,
    });
    writeConfig({ models: { providers: { sample: { ...connection, apiKey: profileId } } } });
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: agentDir("writer"),
        store: {
          version: 1,
          profiles: {
            [profileId]: { type: "api_key", provider: "sample", key: "stale-runtime-key" },
          },
        },
      },
    ]);
    await expect(
      removeModelAuthCredentials({
        cfg: await readConfig(),
        agentDir: agentDir("writer"),
        profileIds: [profileId],
        apiKeyProvider: "sample",
      }),
    ).rejects.toThrow("changed");
    expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles[profileId]).toEqual(
      replacement,
    );
    expect((await readConfig()).models?.providers?.sample?.apiKey).toBe(profileId);
  });

  it.each(["sample:backup", undefined])(
    "preserves a newer provider binding of %s after key entry",
    async (apiKey) => {
      for (const profileId of ["sample:original", "sample:backup"]) {
        await upsertAuthProfileWithLockOrThrow({
          profileId,
          credential: { type: "api_key", provider: "sample", key: profileId },
        });
      }
      writeConfig({
        models: { providers: { sample: { ...connection, apiKey: "sample:original" } } },
      });
      const config = await readConfig();
      const updated = { ...connection, apiKey };
      writeConfig({ models: { providers: { sample: updated } } });

      await expect(
        saveModelProviderApiKey({
          config,
          provider: "sample",
          apiKey: "replacement-key",
          agentDir: agentDir("writer"),
        }),
      ).rejects.toThrow("API key saved, but provider settings could not be applied");
      expect((await readConfig()).models?.providers?.sample).toEqual(updated);
      expect(loadPersistedAuthProfileStore()?.profiles["sample:original"]).toMatchObject({
        key: "replacement-key",
      });
      expect(loadPersistedAuthProfileStore()?.profiles["sample:backup"]).toMatchObject({
        key: "sample:backup",
      });
    },
  );

  it.each(["oauth", "token", "api-key"] as const)(
    "keeps the active %s connection when saving an explicit backup profile",
    async (auth) => {
      const provider = { ...connection, auth, apiKey: "existing-connection-key" };
      writeConfig({ models: { providers: { sample: provider } } });
      expect(await save("backup-key", "sample:backup")).toBe("sample:backup");
      expect((await readConfig()).models?.providers?.sample).toEqual(provider);
      expect(
        loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:backup"],
      ).toMatchObject({ key: "backup-key" });
    },
  );

  it("updates an explicitly selected shared profile at its existing owner", async () => {
    await upsertAuthProfileWithLockOrThrow({
      profileId: "sample:shared",
      credential: { type: "api_key", provider: "sample", key: "old-shared", copyToAgents: false },
    });
    await save("replacement-shared", "sample:shared");
    expect(loadPersistedAuthProfileStore()?.profiles["sample:shared"]).toMatchObject({
      key: "replacement-shared",
      copyToAgents: false,
    });
    expect(
      loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:shared"],
    ).toBeUndefined();
  });
});
