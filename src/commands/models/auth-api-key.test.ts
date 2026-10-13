import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import * as authProfiles from "../../agents/auth-profiles.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import * as authStoreRuntime from "../../agents/auth-profiles/store-runtime.js";
import type { ApiKeyCredential, AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
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
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
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
const save = (apiKey = "synthetic-new-key", profileId?: string) =>
  saveModelProviderApiKey({ provider: "sample", apiKey, profileId, agentDir: agentDir("writer") });

function seedKey(
  profileId: string,
  key: string,
  owner?: string,
  metadata: Pick<ApiKeyCredential, "copyToAgents" | "displayName" | "email"> = {},
) {
  return upsertAuthProfileWithLockOrThrow({
    profileId,
    agentDir: owner ? agentDir(owner) : undefined,
    credential: { type: "api_key", provider: "sample", key, ...metadata },
  });
}

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

describe("shared API-key editing and removal", () => {
  it.each([false, true])(
    "checks requester authority after the credential updater returns (revoked=%s)",
    async (revoke) => {
      await seedKey("sample:manual", "synthetic-before", "writer");
      const beforeConfig = fs.readFileSync(configPath(), "utf8");
      let callbackComplete = false;
      let revoked = false;
      const update = authStoreRuntime.updateAuthProfileStoreWithLock;
      vi.spyOn(authStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation((params) =>
        update({
          ...params,
          updater: (...args) => {
            const changed = params.updater(...args);
            callbackComplete = true;
            revoked = revoke;
            return changed;
          },
        }),
      );
      const result = saveModelProviderApiKey({
        provider: "sample",
        apiKey: "synthetic-after",
        profileId: "sample:manual",
        agentDir: agentDir("writer"),
        assertCurrent: () => {
          if (revoked) {
            throw new Error("Requester revoked at credential commit");
          }
        },
      });
      if (revoke) {
        await expect(result).rejects.toThrow("Requester revoked at credential commit");
        expect(fs.readFileSync(configPath(), "utf8")).toBe(beforeConfig);
      } else {
        await expect(result).resolves.toMatchObject({ profileId: "sample:manual" });
      }
      expect(callbackComplete).toBe(true);
      expect(
        loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:manual"],
      ).toMatchObject({
        key: revoke ? "synthetic-before" : "synthetic-after",
      });
    },
  );

  it.each([false, true])(
    "checks requester authority after the config transform (revoked=%s)",
    async (revoke) => {
      await seedKey("sample:manual", "synthetic-current-key", "writer");
      const beforeConfig = fs.readFileSync(configPath(), "utf8");
      const beforeProfiles = loadPersistedAuthProfileStore(agentDir("writer"))?.profiles;
      let transformed = false;
      let revoked = false;
      const updateConfig = configWriter.updateConfig;
      vi.spyOn(configWriter, "updateConfig").mockImplementation(
        (mutator, selectModels, beforeCommit, writeOptions) =>
          updateConfig(
            async (...args) => {
              const next = await mutator(...args);
              transformed = true;
              revoked = revoke;
              return next;
            },
            selectModels,
            beforeCommit,
            writeOptions,
          ),
      );
      const result = saveModelProviderApiKey({
        provider: "sample",
        apiKey: "synthetic-current-key",
        profileId: "sample:manual",
        agentDir: agentDir("writer"),
        assertCurrent: () => {
          if (revoked) {
            throw new Error("Requester revoked after config transform");
          }
        },
      });
      if (revoke) {
        await expect(result).rejects.toThrow("Requester revoked after config transform");
        expect(fs.readFileSync(configPath(), "utf8")).toBe(beforeConfig);
      } else {
        await expect(result).resolves.toMatchObject({ profileId: "sample:manual" });
        expect((await readConfig()).auth?.profiles?.["sample:manual"]).toMatchObject({
          provider: "sample",
          mode: "api_key",
        });
      }
      expect(transformed).toBe(true);
      expect(loadPersistedAuthProfileStore(agentDir("writer"))?.profiles).toEqual(beforeProfiles);
    },
  );

  it("waits for the saved binding to reach the Gateway before allowing immediate removal", async () => {
    writeConfig({ models: { providers: { sample: { ...connection, apiKey: "old-inline" } } } });
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
      await removeModelAuthCredentials({
        cfg: runtimeConfig,
        agentDir: agentDir("writer"),
        profileIds: ["sample:manual"],
        apiKeyProvider: "sample",
      });
      expect((await readConfig()).models?.providers?.sample?.apiKey).toBeUndefined();
      expect(loadPersistedAuthProfileStore()?.profiles["sample:manual"]).toBeUndefined();
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
        expect((await readConfig()).auth?.profiles?.["sample:manual"]).toEqual({
          provider: "sample",
          mode: "api_key",
        });
        expect(
          loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:manual"],
        ).toMatchObject({
          key: "synthetic-new-key",
        });
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
        provider: "sample",
        mode: "api_key" as const,
        displayName: "Work",
        email: "work@example.test",
      };
      if (!owner) {
        writeConfig({
          plugins: { allow: [] },
          agents: { defaults: { model: "kept/model" } },
          auth: { profiles: { [profileId]: configuredProfile } },
          ...(selection === "configured"
            ? { models: { providers: { sample: { ...connection, apiKey: profileId } } } }
            : {}),
        });
      }
      const result = await save(
        "synthetic-new-key",
        selection === "explicit" ? profileId : undefined,
      );
      const config = await readConfig();
      expect(
        loadPersistedAuthProfileStore(owner ? agentDir(owner) : undefined)?.profiles[profileId],
      ).toMatchObject({ key: "synthetic-new-key", ...metadata });
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
        expect(
          loadPersistedAuthProfileStore(agentDir("writer"))?.profiles[profileId],
        ).toBeUndefined();
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
          profiles: { "sample:bound": { provider: "sample", mode: "api_key" } },
          order: { sample: ["sample:bound"], other: [] },
        },
        models: { providers: { sample: { ...connection, apiKey: boundId } } },
      });
      await removeModelAuthCredentials({
        cfg: await readConfig(),
        agentDir: callerDir,
        profileIds: ["sample:bound"],
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
    const scope = {
      agentId: "writer",
      sessionKey: "agent:writer:chat",
      storePath: resolveDefaultSessionStorePath("writer"),
    };
    await replaceSessionEntry(scope, {
      sessionId: "existing-chat",
      updatedAt: 1,
      modelOverride: "astra",
      providerOverride: "sample",
      modelOverrideSource: "user",
      authProfileOverride: removedId,
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
      modelFallback: {
        source: "agent-patch",
        ts: 3,
        prevModel: "luna",
        prevProvider: "sample",
        prevAuthProfileOverride: removedId,
        prevAuthProfileOverrideSource: "user",
        prevAuthProfileOverrideCompactionCount: 1,
      },
    });
    await removeModelAuthCredentials({
      cfg: await readConfig(),
      agentDir: agentDir("writer"),
      profileIds: [removedId],
    });
    const cfg = await readConfig();
    expect(cfg.agents?.entries?.writer?.model).toBe("sample/astra");
    expect(ensureAuthProfileStoreWithoutExternalProfiles(agentDir("writer")).profiles).toEqual({});
    const existing = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
    expect(existing).toMatchObject({
      sessionId: "existing-chat",
      updatedAt: 1,
      modelOverride: "astra",
      modelOverrideSource: "user",
    });
    expect(existing?.authProfileOverride).toBeUndefined();
    expect(existing?.authProfileOverrideSource).toBeUndefined();
    expect(existing?.authProfileOverrideCompactionCount).toBeUndefined();
    expect(existing?.modelFallback).toMatchObject({
      source: "agent-patch",
      ts: 3,
      prevModel: "luna",
      prevProvider: "sample",
    });
    expect(existing?.modelFallback?.prevAuthProfileOverride).toBeUndefined();
    await seedKey(replacementId, "replacement", "writer");
    const freshScope = { ...scope, sessionKey: "agent:writer:new" };
    await replaceSessionEntry(freshScope, { sessionId: "new-chat", updatedAt: 1 });
    // Original order: reconnect, switch away, then return to the configured model.
    for (const modelId of ["luna", "astra"]) {
      for (const target of [scope, freshScope]) {
        const sessionEntry = loadSessionEntryReadOnly({ ...target, readConsistency: "latest" })!;
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

  it("preserves a same-ID reconnect at the conversation cleanup commit", async () => {
    const profileId = "sample:reconnected";
    const fallbackProfileId = "sample:deleted-fallback";
    writeConfig({ agents: { entries: { writer: { model: `sample/astra@${profileId}` } } } });
    const profile = { agentDir: agentDir("writer"), profileId };
    await seedKey(profileId, "removed", "writer");
    await seedKey(fallbackProfileId, "removed-fallback", "writer");
    const scope = {
      agentId: "writer",
      sessionKey: "agent:writer:chat",
      storePath: resolveDefaultSessionStorePath("writer"),
    };
    await replaceSessionEntry(scope, {
      sessionId: "existing-chat",
      updatedAt: 1,
      authProfileOverride: profileId,
      authProfileOverrideSource: "user",
      modelFallback: {
        source: "agent-patch",
        ts: 1,
        prevModel: "luna",
        prevProvider: "sample",
        prevAuthProfileOverride: fallbackProfileId,
      },
    });
    const patch = sessionAccessor.patchSessionEntryTarget;
    vi.spyOn(sessionAccessor, "patchSessionEntryTarget").mockImplementationOnce(
      (target, update, options) =>
        patch(
          target,
          async (...args) => {
            const change = await update(...args);
            // Reconnect after cleanup has prepared its patch, before the canonical commit.
            await seedKey(profileId, "reconnected", "writer");
            return change;
          },
          options,
        ),
    );
    await removeModelAuthCredentials({
      cfg: await readConfig(),
      agentDir: profile.agentDir,
      profileIds: [profileId, fallbackProfileId],
    });
    expect(loadPersistedAuthProfileStore(profile.agentDir)?.profiles[profileId]).toMatchObject({
      key: "reconnected",
    });
    const retained = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
    expect(retained).toMatchObject({
      authProfileOverride: profileId,
      authProfileOverrideSource: "user",
      updatedAt: 1,
    });
    expect(retained?.modelFallback?.prevAuthProfileOverride).toBeUndefined();
  });

  it("preserves queued work for an account reconnected after credential removal", async () => {
    const profileId = "sample:reconnected";
    const removedId = "sample:removed";
    const queueKey = "agent:writer:reconnect";
    const config: OpenClawConfig = {
      agents: {
        entries: {
          writer: {
            model: {
              primary: `sample/astra@${profileId}`,
              fallbacks: [`sample/luna@${removedId}`],
            },
          },
        },
      },
    };
    writeConfig(config);
    for (const id of [profileId, removedId]) {
      await seedKey(id, "removed", "writer");
    }
    const queued = (id: string, snapshot: OpenClawConfig) => {
      const pending = createQueueTestRun({ prompt: id });
      Object.assign(pending.run, {
        agentId: "writer",
        agentDir: agentDir("writer"),
        config: snapshot,
        provider: "sample",
        model: "astra",
        authProfileId: id,
        authProfileIdSource: "user",
      });
      return pending;
    };
    const removedRun = queued(removedId, config);
    const reconnectedConfig: OpenClawConfig = {
      agents: { entries: { writer: { model: `sample/astra@${profileId}` } } },
    };
    const reconnectedRun = queued(profileId, reconnectedConfig);
    const remove = authProfiles.removeAuthProfilesAcrossOwnerStores;
    vi.spyOn(authProfiles, "removeAuthProfilesAcrossOwnerStores").mockImplementationOnce(
      async (params) => {
        const result = await remove(params);
        expect(result).toBe(true);
        await seedKey(profileId, "reconnected", "writer");
        writeConfig(reconnectedConfig);
        enqueueFollowupRun(queueKey, reconnectedRun, { mode: "followup" });
        return result;
      },
    );
    try {
      enqueueFollowupRun(queueKey, removedRun, { mode: "followup" });
      await removeModelAuthCredentials({
        cfg: config,
        agentDir: agentDir("writer"),
        profileIds: [profileId, removedId],
      });
      expect(reconnectedRun.run.authProfileId).toBe(profileId);
      expect(reconnectedRun.run.authProfileIdSource).toBe("user");
      expect(reconnectedRun.run.config).toBe(reconnectedConfig);
      expect(removedRun.run.authProfileId).toBeUndefined();
      expect(removedRun.run.config.agents?.entries?.writer?.model).toEqual({
        primary: `sample/astra@${profileId}`,
        fallbacks: ["sample/luna"],
      });
    } finally {
      clearFollowupQueue(queueKey);
    }
  });

  it("releases a shared default without changing another agent's independent same-ID account", async () => {
    const profileId = "sample:shared";
    await seedKey(profileId, "shared");
    await seedKey(profileId, "independent", "reader");
    writeConfig({
      plugins: { allow: [] },
      agents: {
        ownership: "explicit",
        defaults: {
          model: { primary: `sample/astra@${profileId}`, fallbacks: ["sample/luna@sample:backup"] },
          utilityModel: `sample/luna@${profileId}`,
        },
        entries: { main: {}, reader: {} },
      },
    });
    const scope = (id: string) => ({
      agentId: id,
      storePath: resolveDefaultSessionStorePath(id),
      sessionKey: "global",
    });
    for (const id of ["main", "reader"]) {
      await replaceSessionEntry(scope(id), {
        sessionId: `${id}-chat`,
        updatedAt: 1,
        authProfileOverride: profileId,
        authProfileOverrideSource: "user",
      });
    }
    await removeModelAuthCredentials({
      cfg: await readConfig(),
      agentDir: agentDir("main"),
      profileIds: [profileId],
    });
    const cfg = await readConfig();
    expect(cfg.agents?.defaults?.model).toEqual({
      primary: "sample/astra",
      fallbacks: ["sample/luna@sample:backup"],
    });
    expect(cfg.agents?.defaults?.utilityModel).toBe("sample/luna");
    expect(cfg.agents?.entries?.reader?.model).toEqual({
      primary: `sample/astra@${profileId}`,
      fallbacks: ["sample/luna@sample:backup"],
    });
    expect(resolveAgentModelFallbacksOverride(cfg, "reader")).toEqual([
      "sample/luna@sample:backup",
    ]);
    expect(cfg.agents?.entries?.reader?.utilityModel).toBe(`sample/luna@${profileId}`);
    expect(loadPersistedAuthProfileStore(agentDir("reader"))?.profiles[profileId]).toMatchObject({
      key: "independent",
    });
    expect(
      loadSessionEntryReadOnly({ ...scope("main"), readConsistency: "latest" })
        ?.authProfileOverride,
    ).toBeUndefined();
    expect(
      loadSessionEntryReadOnly({ ...scope("reader"), readConsistency: "latest" })
        ?.authProfileOverride,
    ).toBe(profileId);
  });

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
    await seedKey("sample:inline", "removed", "writer");
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

  it.each<{
    name: string;
    owner?: string;
    profileId?: string;
    credential: AuthProfileCredential;
    config?: OpenClawConfig;
    error: string;
  }>([
    {
      name: "another agent's override",
      owner: "reader",
      credential: { type: "api_key", provider: "sample", key: "kept-local" },
      config: { models: { providers: { sample: { ...connection, apiKey: "old-inline" } } } },
      error: "An agent already overrides this shared key",
    },
    {
      name: "the configured agent-local binding",
      owner: "writer",
      profileId: "sample:local",
      credential: { type: "api_key", provider: "sample", key: "kept-local", copyToAgents: false },
      config: { models: { providers: { sample: { ...connection, apiKey: "sample:local" } } } },
      error: "An agent already overrides this shared key",
    },
    {
      name: "another provider's key",
      owner: "writer",
      credential: { type: "api_key", provider: "other", key: "kept" },
      error: "belongs to another sign-in",
    },
    {
      name: "a token sign-in",
      owner: "writer",
      credential: { type: "token", provider: "sample", token: "kept" },
      error: "belongs to another sign-in",
    },
    ...["sample:external", "sample:manual"].map((profileId) => ({
      name: `external reference ${profileId}`,
      profileId,
      credential: {
        type: "api_key" as const,
        provider: "sample",
        keyRef: { source: "env" as const, provider: "default", id: "SAMPLE_API_KEY" },
        copyToAgents: false,
      },
      config: {
        models: {
          providers: {
            sample:
              profileId === "sample:external" ? { ...connection, apiKey: profileId } : connection,
          },
        },
      },
      error: "uses an external secret reference",
    })),
  ])(
    "preserves $name when key replacement is refused",
    async ({
      owner,
      profileId = "sample:manual",
      credential,
      config = { plugins: { allow: [] } },
      error,
    }) => {
      const storeDir = owner ? agentDir(owner) : undefined;
      await upsertAuthProfileWithLockOrThrow({ agentDir: storeDir, profileId, credential });
      writeConfig(config);
      const before = fs.readFileSync(configPath(), "utf8");
      await expect(save()).rejects.toThrow(error);
      expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
      expect(loadPersistedAuthProfileStore(storeDir)?.profiles[profileId]).toEqual(credential);
      expect((await readConfig()).models).toEqual(config.models);
    },
  );

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
  it.each(["concurrent token", "concurrent reference", "durable token"])(
    "preserves a %s despite a stale API-key snapshot during removal",
    async (kind) => {
      const profileId = "sample:race";
      const replacement: AuthProfileCredential =
        kind === "concurrent reference"
          ? {
              type: "api_key",
              provider: "sample",
              keyRef: { source: "env", provider: "default", id: "AUTH_B_REPLACEMENT" },
            }
          : { type: "token", provider: "sample", token: "kept-replacement" };
      const installReplacement = async () => {
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
      };
      writeConfig({ models: { providers: { sample: { ...connection, apiKey: profileId } } } });
      if (kind === "durable token") {
        await installReplacement();
      } else {
        await seedKey(profileId, "old-key", "writer");
        const updateConfig = configWriter.updateConfig;
        vi.spyOn(configWriter, "updateConfig").mockImplementationOnce(async (mutator) => {
          await installReplacement();
          return updateConfig(mutator);
        });
      }
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
    },
  );

  it("retains the credential when config reference cleanup fails", async () => {
    const { profileId } = await save();
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
      await seedKey(profileId, "old-key", "writer");
      writeConfig({
        agents: { entries: { writer: { model: `sample/astra@${profileId}` } } },
        auth: {
          profiles: { [profileId]: { provider: "sample", mode: "api_key" } },
          order: { sample: [profileId] },
        },
        models: { providers: { sample: { ...connection, apiKey: profileId } } },
      });
      const config = await readConfig();
      const updateConfig = configWriter.updateConfig;
      vi.spyOn(configWriter, "updateConfig").mockImplementationOnce(async (mutator) => {
        await seedKey(profileId, "replacement-key", "writer");
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
      expect(restored.agents?.entries?.writer?.model).toBe(`sample/astra@${profileId}`);
      expect(restored.auth?.profiles?.[profileId]).toEqual({
        provider: "sample",
        mode: "api_key",
      });
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

  it("keeps the active OAuth connection when saving an explicit backup profile", async () => {
    const provider = { ...connection, auth: "oauth" as const, apiKey: "existing-connection-key" };
    writeConfig({ models: { providers: { sample: provider } } });
    expect(await save("backup-key", "sample:backup")).toMatchObject({
      profileId: "sample:backup",
    });
    expect((await readConfig()).models?.providers?.sample).toEqual(provider);
    expect(
      loadPersistedAuthProfileStore(agentDir("writer"))?.profiles["sample:backup"],
    ).toMatchObject({ key: "backup-key" });
  });
});
