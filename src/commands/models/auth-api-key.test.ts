import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveApiKeyForProfile,
  replaceRuntimeAuthProfileStoreSnapshots,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import * as authStoreRuntime from "../../agents/auth-profiles/store-runtime.js";
import type { ApiKeyCredential, AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { registerRuntimeConfigWriteListener } from "../../config/runtime-snapshot.js";
import {
  getRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationClaim,
} from "../../config/runtime-write-application.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { saveModelProviderApiKey } from "./auth-api-key.js";
import { removeModelAuthCredentials } from "./auth-logout.js";
import * as configWriter from "./shared.js";

const tempDirs = createTempDirTracker();
const connection = { baseUrl: "http://127.0.0.1:9/v1", models: [] };
let stateDir: string;
const agentDir = (id: string) => path.join(stateDir, "agents", id, "agent");
const configPath = () => path.join(stateDir, "openclaw.json");
const writeConfig = (config: OpenClawConfig) =>
  fs.writeFileSync(configPath(), JSON.stringify(config));
const save = (
  apiKey = "synthetic-new-key",
  profileId?: string,
  options: Partial<Parameters<typeof saveModelProviderApiKey>[0]> = {},
) =>
  saveModelProviderApiKey({
    provider: "sample",
    apiKey,
    profileId,
    agentDir: agentDir("writer"),
    ...options,
  });
const profileConfig = { provider: "sample", mode: "api_key" as const };
const keyCredential = (key: string, provider = "sample"): ApiKeyCredential => ({
  type: "api_key",
  provider,
  key,
});
const externalCredential = (id: string): ApiKeyCredential => ({
  type: "api_key",
  provider: "sample",
  keyRef: { source: "env", provider: "default", id },
});
const profiles = (owner: string | null = "writer") =>
  loadPersistedAuthProfileStore(owner ? agentDir(owner) : undefined)?.profiles;
const readProvider = async () => (await readConfig()).models?.providers?.sample;
const configBytes = () => fs.readFileSync(configPath(), "utf8");
const replaceCredential = (profileId: string, credential: AuthProfileCredential, owner?: string) =>
  upsertAuthProfileWithLockOrThrow({
    profileId,
    credential,
    agentDir: owner ? agentDir(owner) : undefined,
  });
function beforeConfigUpdate(callback: () => Promise<unknown>) {
  const updateConfig = configWriter.updateConfig;
  vi.spyOn(configWriter, "updateConfig").mockImplementationOnce(async (mutator) => {
    await callback();
    return updateConfig(mutator);
  });
}

function seedKey(
  profileId: string,
  key: string,
  owner?: string,
  metadata: Pick<ApiKeyCredential, "copyToAgents" | "displayName" | "email"> = {},
) {
  return replaceCredential(profileId, { ...keyCredential(key), ...metadata }, owner);
}

async function readConfig() {
  return (await configWriter.loadValidConfigSnapshotOrThrow()).runtimeConfig;
}

function boundConfig(apiKey?: string): OpenClawConfig {
  return { models: { providers: { sample: { ...connection, apiKey } } } };
}
const sessionScope = (agentId: string, sessionKey = "global") => ({
  agentId,
  sessionKey,
  storePath: resolveDefaultSessionStorePath(agentId),
});
const readSession = (scope: ReturnType<typeof sessionScope>) =>
  loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });

function savedProfile(profileId = "sample:manual", owner: string | null = "writer") {
  return profiles(owner)?.[profileId];
}

async function remove(
  profileId: string,
  options: Partial<Parameters<typeof removeModelAuthCredentials>[0]> = {},
) {
  return removeModelAuthCredentials({
    cfg: options.cfg ?? (await readConfig()),
    agentDir: agentDir("writer"),
    profileIds: [profileId],
    ...options,
  });
}

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-shared-api-key-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath());
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  vi.stubEnv("OPENCLAW_OAUTH_DIR", undefined);
  writeConfig({ plugins: { allow: [] } });
});
afterEach(async () => {
  try {
    clearRuntimeAuthProfileStoreSnapshots();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it.each([
  ["credential commit", false],
  ["credential commit", true],
  ["config transform", false],
  ["config transform", true],
] as const)("checks requester authority after %s (revoked=%s)", async (stage, revoke) => {
  await seedKey("sample:manual", "synthetic-before", "writer");
  const beforeConfig = configBytes();
  const beforeProfiles = profiles();
  let callbackComplete = false;
  let revoked = false;
  const complete = () => {
    callbackComplete = true;
    revoked = revoke;
  };
  if (stage === "credential commit") {
    const update = authStoreRuntime.updateAuthProfileStoreWithLock;
    vi.spyOn(authStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation((params) =>
      update({
        ...params,
        updater: (...args) => {
          const changed = params.updater(...args);
          complete();
          return changed;
        },
      }),
    );
  } else {
    const updateConfig = configWriter.updateConfig;
    vi.spyOn(configWriter, "updateConfig").mockImplementation((mutator, ...options) =>
      updateConfig(
        async (...args) => {
          const next = await mutator(...args);
          complete();
          return next;
        },
        ...options,
      ),
    );
  }
  const error = `Requester revoked after ${stage}`;
  const assertCurrent = () => {
    if (revoked) {
      throw new Error(error);
    }
  };
  const nextKey = stage === "credential commit" ? "synthetic-after" : "synthetic-before";
  const result = save(nextKey, "sample:manual", { assertCurrent });
  if (revoke) {
    await expect(result).rejects.toThrow(error);
    expect(configBytes()).toBe(beforeConfig);
  } else {
    await expect(result).resolves.toMatchObject({ profileId: "sample:manual" });
    if (stage === "config transform") {
      expect((await readConfig()).auth?.profiles?.["sample:manual"]).toMatchObject(profileConfig);
    }
  }
  expect(callbackComplete).toBe(true);
  if (stage === "config transform") {
    expect(profiles()).toEqual(beforeProfiles);
  } else {
    expect(savedProfile()).toMatchObject({ key: revoke ? "synthetic-before" : "synthetic-after" });
  }
});

it("waits for the saved binding to reach the Gateway before allowing immediate removal", async () => {
  writeConfig(boundConfig("old-inline"));
  let claim: RuntimeConfigWriteApplicationClaim | undefined;
  const written = createDeferred();
  const updateConfig = configWriter.updateConfig;
  vi.spyOn(configWriter, "updateConfig").mockImplementationOnce(async (...args) => {
    const config = await updateConfig(...args);
    written.resolve();
    return config;
  });
  const stop = registerRuntimeConfigWriteListener((event) => {
    claim = getRuntimeConfigWriteApplication(event)?.claim() ?? undefined;
  });
  const response = save();
  try {
    await written.promise;
    expect(
      await Promise.race([response.then(() => "completed"), nextEventLoopTurn("pending")]),
    ).toBe("pending");
    const runtimeConfig = await readConfig();
    claim?.settle("applied");
    expect(await response).toEqual({ profileId: "sample:manual" });
    stop();
    await remove("sample:manual", { cfg: runtimeConfig, apiKeyProvider: "sample" });
    expect((await readProvider())?.apiKey).toBeUndefined();
    expect(savedProfile("sample:manual", null)).toBeUndefined();
  } finally {
    claim?.settle("failed");
    stop();
    await response;
  }
});

it.each(["restart-pending", "unclaimed"] as const)(
  "reports a saved key with a warning when config application is %s",
  async (status) => {
    const stop = registerRuntimeConfigWriteListener((event) => {
      if (status !== "unclaimed") {
        getRuntimeConfigWriteApplication(event)?.claim()?.settle(status);
      }
    });
    try {
      expect(await save()).toEqual({
        profileId: "sample:manual",
        warning: expect.stringContaining("Gateway has not confirmed applying"),
      });
      expect((await readConfig()).auth?.profiles?.["sample:manual"]).toEqual(profileConfig);
      expect(savedProfile()).toMatchObject({ key: "synthetic-new-key" });
    } finally {
      stop();
    }
  },
);

it.each(["configured", "explicit", "ordered"])(
  "replaces the %s key at its owner, preserving metadata and unselected accounts",
  async (selection) => {
    const profileId = "sample:work";
    const owner = selection === "ordered" ? "writer" : undefined;
    const metadata = {
      copyToAgents: false,
      displayName: "Stored account",
      email: "stored@example.test",
    };
    await seedKey(profileId, "old-key", owner, metadata);
    if (owner) {
      await seedKey("sample:backup", "kept-backup", owner);
      await setAuthProfileOrder({
        agentDir: agentDir(owner),
        provider: "sample",
        order: [profileId, "sample:backup"],
      });
    }
    const ownerDir = owner ? agentDir(owner) : undefined;
    const stored = loadPersistedAuthProfileStore(ownerDir)!;
    const failureState = {
      lastUsed: 1_700_000_000_000,
      cooldownUntil: Date.now() + 60_000,
      cooldownReason: "rate_limit" as const,
      errorCount: 3,
      failureCounts: { rate_limit: 3 },
    };
    stored.usageStats = {
      [profileId]: failureState,
      ...(owner ? { "sample:backup": failureState } : {}),
    };
    authStoreRuntime.saveAuthProfileStore(stored, ownerDir);
    const configuredProfile = {
      ...profileConfig,
      displayName: "Work",
      email: "work@example.test",
    };
    if (!owner) {
      writeConfig({
        plugins: { allow: [] },
        agents: { defaults: { model: "kept/model" } },
        auth: { profiles: { [profileId]: configuredProfile } },
        ...(selection === "configured" ? boundConfig(profileId) : {}),
      });
    }
    const result = await save(
      "synthetic-new-key",
      selection === "explicit" ? profileId : undefined,
    );
    const config = await readConfig();
    expect(savedProfile(profileId, owner ?? null)).toMatchObject({
      key: "synthetic-new-key",
      ...metadata,
    });
    const usageStats = loadPersistedAuthProfileStore(ownerDir)?.usageStats;
    expect(usageStats?.[profileId]).toEqual({ lastUsed: failureState.lastUsed, errorCount: 0 });
    if (owner) {
      expect(usageStats?.["sample:backup"]).toEqual(failureState);
      expect(result).toMatchObject({ profileId });
      const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir(owner));
      expect(store.profiles[profileId]).toMatchObject({ key: "synthetic-new-key" });
      expect(store.profiles["sample:backup"]).toMatchObject({ key: "kept-backup" });
      expect(store.order?.sample).toEqual([profileId, "sample:backup"]);
      expect(config.models).toBeUndefined();
    } else {
      expect(result).toEqual({ profileId });
      expect(config.agents?.defaults?.model).toBe("kept/model");
      expect(config.models?.providers?.sample).toEqual(
        selection === "configured" ? { ...connection, apiKey: profileId } : undefined,
      );
      expect(config.auth?.profiles?.[profileId]).toEqual(configuredProfile);
      expect(savedProfile(profileId)).toBeUndefined();
      const reader = agentDir("reader");
      await expect(
        resolveApiKeyForProfile({
          cfg: config,
          store: ensureAuthProfileStoreWithoutExternalProfiles(reader),
          profileId,
          agentDir: reader,
        }),
      ).resolves.toMatchObject({ apiKey: "synthetic-new-key" });
    }
  },
);

it.each(["main", "reader", "full-provider"])(
  "removes planned credentials and bindings through %s while retaining unselected state",
  async (caller) => {
    const fullProvider = caller === "full-provider";
    const owner = fullProvider ? "writer" : undefined;
    const callerDir = agentDir(fullProvider ? "writer" : caller);
    const boundId = fullProvider ? "sample:backup" : "sample:bound";
    await seedKey("sample:bound", "removed", owner);
    await seedKey("sample:backup", "kept", owner);
    writeConfig({
      plugins: { allow: [] },
      agents: { defaults: { model: "sample/model" } },
      auth: {
        profiles: { "sample:bound": profileConfig },
        order: { sample: ["sample:bound"], other: [] },
      },
      ...boundConfig(boundId),
    });
    await remove("sample:bound", {
      agentDir: callerDir,
      ...(fullProvider ? { provider: "sample" } : {}),
    });
    const config = await readConfig();
    expect(config.auth).toEqual({ profiles: {}, order: { other: [] } });
    expect(config.models?.providers?.sample).toEqual(connection);
    expect(config.agents?.defaults?.model).toBe("sample/model");
    const store = ensureAuthProfileStoreWithoutExternalProfiles(callerDir);
    expect(store.profiles["sample:bound"]).toBeUndefined();
    if (fullProvider) {
      expect(loadPersistedAuthProfileStore(callerDir)?.profiles).toEqual({});
      expect(config.models?.providers?.sample?.apiKey).toBeUndefined();
    } else {
      expect(store.profiles["sample:backup"]).toMatchObject({ key: "kept" });
    }
  },
);

it("deleting the selected account preserves the model and releases existing and new chats", async () => {
  const removedId = "sample:old";
  const replacementId = "sample:new";
  writeConfig({
    plugins: { allow: [] },
    agents: { entries: { writer: { model: `sample/astra@${removedId}` } } },
  });
  await seedKey(removedId, "removed", "writer");
  const scope = sessionScope("writer", "agent:writer:chat");
  const retainedSession = {
    sessionId: "existing-chat",
    updatedAt: 1,
    modelOverride: "astra",
    modelOverrideSource: "user" as const,
  };
  const retainedFallback = {
    source: "agent-patch" as const,
    ts: 3,
    prevModel: "luna",
    prevProvider: "sample",
  };
  await replaceSessionEntry(scope, {
    ...retainedSession,
    providerOverride: "sample",
    authProfileOverride: removedId,
    authProfileOverrideSource: "user",
    authProfileOverrideCompactionCount: 2,
    modelFallback: {
      ...retainedFallback,
      prevAuthProfileOverride: removedId,
      prevAuthProfileOverrideSource: "user",
      prevAuthProfileOverrideCompactionCount: 1,
    },
  });
  await remove(removedId);
  const cfg = await readConfig();
  expect(cfg.agents?.entries?.writer?.model).toBe("sample/astra");
  expect(ensureAuthProfileStoreWithoutExternalProfiles(agentDir("writer")).profiles).toEqual({});
  const existing = readSession(scope);
  expect(existing).toMatchObject(retainedSession);
  expect([
    existing?.authProfileOverride,
    existing?.authProfileOverrideSource,
    existing?.authProfileOverrideCompactionCount,
  ]).toEqual([undefined, undefined, undefined]);
  expect(existing?.modelFallback).toMatchObject(retainedFallback);
  expect(existing?.modelFallback?.prevAuthProfileOverride).toBeUndefined();
  await seedKey(replacementId, "replacement", "writer");
  const freshScope = { ...scope, sessionKey: "agent:writer:new" };
  await replaceSessionEntry(freshScope, { sessionId: "new-chat", updatedAt: 1 });
  for (const modelId of ["luna", "astra"]) {
    for (const target of [scope, freshScope]) {
      const sessionEntry = readSession(target)!;
      await expect(
        resolveSessionAuthSelection({
          cfg,
          agentId: "writer",
          agentDir: agentDir("writer"),
          provider: "sample",
          modelId,
          sessionEntry,
          sessionStore: { [target.sessionKey]: sessionEntry },
          sessionKey: target.sessionKey,
          storePath: target.storePath,
          isNewSession: target === freshScope,
        }),
      ).resolves.toMatchObject({ profileId: replacementId });
    }
  }
});

it("releases a shared default without changing another agent's independent same-ID account", async () => {
  const profileId = "sample:shared";
  const fallbacks = ["sample/luna@sample:backup"];
  const selectedModels = (suffix = "") => ({
    model: { primary: `sample/astra${suffix}`, fallbacks },
    utilityModel: `sample/luna${suffix}`,
  });
  const boundModels = selectedModels(`@${profileId}`);
  await seedKey(profileId, "shared");
  await seedKey(profileId, "independent", "reader");
  writeConfig({
    plugins: { allow: [] },
    agents: {
      ownership: "explicit",
      defaults: boundModels,
      entries: { main: {}, reader: {} },
    },
  });
  for (const id of ["main", "reader"]) {
    await replaceSessionEntry(sessionScope(id), {
      sessionId: `${id}-chat`,
      updatedAt: 1,
      authProfileOverride: profileId,
      authProfileOverrideSource: "user",
    });
  }
  await remove(profileId, { agentDir: agentDir("main") });
  const cfg = await readConfig();
  expect({
    model: cfg.agents?.defaults?.model,
    utilityModel: cfg.agents?.defaults?.utilityModel,
  }).toEqual(selectedModels());
  expect({
    model: cfg.agents?.entries?.reader?.model,
    utilityModel: cfg.agents?.entries?.reader?.utilityModel,
  }).toEqual(boundModels);
  expect(resolveAgentModelFallbacksOverride(cfg, "reader")).toEqual(fallbacks);
  expect(savedProfile(profileId, "reader")).toMatchObject({ key: "independent" });
  expect(readSession(sessionScope("main"))?.authProfileOverride).toBeUndefined();
  expect(readSession(sessionScope("reader"))?.authProfileOverride).toBe(profileId);
});

it("preserves an externally managed key and its binding when removing inline keys", async () => {
  const external = externalCredential("AUTH_B_EXTERNAL");
  await replaceCredential("sample:external", external, "writer");
  await seedKey("sample:inline", "removed", "writer");
  writeConfig(boundConfig("sample:external"));
  await remove("sample:inline", { apiKeyProvider: "sample" });
  expect(profiles()).toEqual({ "sample:external": external });
  expect((await readProvider())?.apiKey).toBe("sample:external");
});

it.each([
  "other-agent override",
  "local override",
  "other provider",
  "token",
  "bound secret",
  "default secret",
])("preserves %s when key replacement is refused", async (kind) => {
  const external = kind.endsWith("secret");
  const override = kind.endsWith("override");
  const profileId =
    kind === "local override"
      ? "sample:local"
      : kind === "bound secret"
        ? "sample:external"
        : "sample:manual";
  const owner = external ? undefined : kind === "other-agent override" ? "reader" : "writer";
  const credential: AuthProfileCredential = external
    ? { ...externalCredential("SAMPLE_API_KEY"), copyToAgents: false }
    : kind === "token"
      ? { type: "token", provider: "sample", token: "kept" }
      : kind === "other provider"
        ? keyCredential("kept", "other")
        : {
            ...keyCredential("kept-local"),
            ...(kind === "local override" ? { copyToAgents: false } : {}),
          };
  const config: OpenClawConfig = external
    ? boundConfig(kind === "bound secret" ? profileId : undefined)
    : override
      ? boundConfig(kind === "local override" ? profileId : "old-inline")
      : { plugins: { allow: [] } };
  const error = external
    ? "uses an external secret reference"
    : override
      ? "An agent already overrides this shared key"
      : "belongs to another sign-in";
  await replaceCredential(profileId, credential, owner);
  writeConfig(config);
  const before = configBytes();
  await expect(save()).rejects.toThrow(error);
  expect(configBytes()).toBe(before);
  expect(savedProfile(profileId, owner ?? null)).toEqual(credential);
  expect((await readConfig()).models).toEqual(config.models);
});

it.each([false, true])(
  "preserves a shared key when an agent override wins the write wait (existing database=%s)",
  async (existingDatabase) => {
    const profileId = "sample:shared";
    await seedKey(profileId, "synthetic-before");
    if (existingDatabase) {
      await seedKey("sample:other", "synthetic-other", "reader");
    }
    writeConfig({
      agents: { ownership: "explicit", entries: { writer: {}, reader: {} } },
      models: { providers: { sample: { ...connection, apiKey: profileId } } },
    });
    const beforeConfig = fs.readFileSync(configPath(), "utf8");
    const update = authStoreRuntime.updateAuthProfileStoreWithLock;
    vi.spyOn(authStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementationOnce(
      async (params) => {
        await seedKey(profileId, "synthetic-override", "reader");
        return update(params);
      },
    );

    await expect(save()).rejects.toThrow("An agent already overrides this shared key");
    expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toMatchObject({
      key: "synthetic-before",
    });
    expect(loadPersistedAuthProfileStore(agentDir("reader"))?.profiles[profileId]).toMatchObject({
      key: "synthetic-override",
    });
    expect(fs.readFileSync(configPath(), "utf8")).toBe(beforeConfig);
  },
);

it("reports saved key material separately from failed config application and redacts it", async () => {
  vi.spyOn(configWriter, "updateConfig").mockRejectedValueOnce(new Error("config write failed"));
  await expect(save("ordinary-fixture\r\n-key-8304")).rejects.toThrow(
    "API key saved, but provider settings could not be applied",
  );
  expect(savedProfile()).toMatchObject({ key: "ordinary-fixture-key-8304" });
  expect(redactSensitiveText("error: ordinary-fixture-key-8304")).not.toContain(
    "ordinary-fixture-key-8304",
  );
});
it.each(["concurrent token", "concurrent reference", "durable token"])(
  "preserves a %s despite a stale API-key snapshot during removal",
  async (kind) => {
    const profileId = "sample:race";
    const replacement: AuthProfileCredential =
      kind === "concurrent reference"
        ? externalCredential("AUTH_B_REPLACEMENT")
        : { type: "token", provider: "sample", token: "kept-replacement" };
    const installReplacement = async () => {
      await replaceCredential(profileId, replacement, "writer");
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir: agentDir("writer"),
          store: {
            version: 1,
            profiles: { [profileId]: keyCredential("stale-key") },
          },
        },
      ]);
    };
    writeConfig(boundConfig(profileId));
    if (kind === "durable token") {
      await installReplacement();
    } else {
      await seedKey(profileId, "old-key", "writer");
      beforeConfigUpdate(installReplacement);
    }
    await expect(remove(profileId, { apiKeyProvider: "sample" })).rejects.toThrow("changed");
    expect(savedProfile(profileId)).toEqual(replacement);
    expect((await readProvider())?.apiKey).toBe(profileId);
  },
);

it("retains the credential when config reference cleanup fails", async () => {
  const { profileId } = await save();
  vi.spyOn(configWriter, "updateConfig").mockRejectedValueOnce(new Error("config write failed"));
  await expect(remove(profileId)).rejects.toThrow("config write failed");
  expect(savedProfile(profileId)).toMatchObject({ key: "synthetic-new-key" });
});

it("preserves a new profile and binding added after full-provider removal was planned", async () => {
  await save("old-key", "sample:old");
  const config = await readConfig();
  beforeConfigUpdate(async () => {
    await replaceCredential(
      "sample:new",
      { type: "token", provider: "sample", token: "kept-new-token" },
      "writer",
    );
    writeConfig(boundConfig("sample:new"));
  });
  await expect(remove("sample:old", { cfg: config, provider: "sample" })).rejects.toThrow(
    "could not be removed",
  );
  expect(savedProfile("sample:new")).toMatchObject({ token: "kept-new-token" });
  expect((await readProvider())?.apiKey).toBe("sample:new");
});

it.each([
  { name: "API-key-only", selection: { apiKeyProvider: "sample" } },
  { name: "full-provider", selection: { provider: "sample" } },
])(
  "restores config after a concurrent same-profile replacement rejects $name removal",
  async ({ selection }) => {
    const profileId = "sample:race";
    await seedKey(profileId, "old-key", "writer");
    writeConfig({
      ...boundConfig(profileId),
      agents: { entries: { writer: { model: `sample/astra@${profileId}` } } },
      auth: { profiles: { [profileId]: profileConfig }, order: { sample: [profileId] } },
    });
    const config = await readConfig();
    beforeConfigUpdate(() => seedKey(profileId, "replacement-key", "writer"));

    await expect(remove(profileId, { cfg: config, ...selection })).rejects.toThrow(
      "could not be removed",
    );

    expect(savedProfile(profileId)).toMatchObject({ key: "replacement-key" });
    const restored = await readConfig();
    expect(restored.agents?.entries?.writer?.model).toBe(`sample/astra@${profileId}`);
    expect(restored.auth?.profiles?.[profileId]).toEqual(profileConfig);
    expect(restored.auth?.order?.sample).toEqual([profileId]);
    expect(restored.models?.providers?.sample?.apiKey).toBe(profileId);
  },
);

it.each(["sample:backup", undefined])(
  "preserves a newer provider binding of %s after key entry",
  async (apiKey) => {
    for (const profileId of ["sample:original", "sample:backup"]) {
      await seedKey(profileId, profileId);
    }
    writeConfig(boundConfig("sample:original"));
    const config = await readConfig();
    const updated = { ...connection, apiKey };
    writeConfig({ models: { providers: { sample: updated } } });

    await expect(save("replacement-key", undefined, { config })).rejects.toThrow(
      "API key saved, but provider settings could not be applied",
    );
    expect(await readProvider()).toEqual(updated);
    expect(profiles(null)).toMatchObject({
      "sample:original": { key: "replacement-key" },
      "sample:backup": { key: "sample:backup" },
    });
  },
);

it("keeps the active OAuth connection when saving an explicit backup profile", async () => {
  const provider = { ...connection, auth: "oauth" as const, apiKey: "existing-connection-key" };
  writeConfig({ models: { providers: { sample: provider } } });
  expect(await save("backup-key", "sample:backup")).toMatchObject({
    profileId: "sample:backup",
  });
  expect((await readConfig()).models?.providers?.sample).toEqual(provider);
  expect(savedProfile("sample:backup")).toMatchObject({ key: "backup-key" });
});
