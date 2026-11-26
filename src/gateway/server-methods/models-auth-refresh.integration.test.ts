import { expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "../../agents/auth-profiles/sqlite-json.js";
import { writePersistedAuthProfileStoreRaw } from "../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { getActiveSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";
import {
  connectModelsReader,
  createModelsTestState,
  modelsTestConfig,
  startModelsGateway,
  writeAuthStoreExternally,
} from "./models-integration.test-support.js";

function tokenStore(provider: string, profile: string): AuthProfileStore {
  return {
    version: 1,
    profiles: { [`${provider}:${profile}`]: { type: "token", provider, token: "synthetic-token" } },
  };
}

async function refresh(
  client: Awaited<ReturnType<typeof startModelsGateway>>["client"],
  operation: "login" | "logout",
  profileId?: string,
) {
  await expect(
    client.request("models.authRefresh", { agentId: "main", operation }),
  ).resolves.toEqual({
    refreshed: true,
  });
  if (profileId) {
    const { providers } = await client.request<ModelAuthStatusResult>("models.authStatus", {
      agentId: "main",
    });
    expect(
      providers.find(({ provider }) => provider === profileId.split(":")[0])?.profiles,
    ).toContainEqual(expect.objectContaining({ profileId }));
  }
}

it("clears transient cooldowns on refresh when clearTransientCooldowns is set for both shared and local stores", async () => {
  await using state = await createModelsTestState("models-auth-refresh-cooldown");
  const token = "auth-refresh-cooldown-token";
  const cfg = modelsTestConfig(state, token);
  await state.writeConfig(cfg);
  await using gateway = await startModelsGateway(state, cfg, token);
  await gateway.server.startupSettled;
  const { client } = gateway;

  // Set shared auth store state
  writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
  const sharedProfileId = "shared-provider:key";
  const sharedStore: AuthProfileStore = {
    version: 1,
    profiles: {
      [sharedProfileId]: { type: "token", provider: "shared-provider", token: "shared-tok" },
    },
    usageStats: {
      [sharedProfileId]: {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        errorCount: 2,
        disabledUntil: Date.now() + 60_000,
        disabledReason: "billing",
      },
    },
  };
  runOpenClawStateWriteTransaction((database) => {
    writePersistedAuthProfileStoreRaw(sharedStore, undefined, database);
  });

  const localProfileId = "local-provider:key";
  const localStore: AuthProfileStore = {
    version: 1,
    profiles: { [localProfileId]: { type: "token", provider: "local-provider", token: "tok" } },
    usageStats: {
      [localProfileId]: {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        errorCount: 2,
        failureCounts: { timeout: 1 },
        disabledUntil: Date.now() + 60_000,
        disabledReason: "billing",
      },
    },
  };
  await state.writeAuthProfiles(localStore);

  // Normal refresh without the flag keeps transient cooldowns
  await expect(
    client.request("models.authRefresh", { agentId: "main", operation: "update" }),
  ).resolves.toEqual({ refreshed: true });
  let localPersisted = loadPersistedAuthProfileStore(state.agentDir());
  expect(localPersisted?.usageStats?.[localProfileId]?.cooldownReason).toBe("rate_limit");

  // Refresh with clearTransientCooldowns clears rate_limit in both shared and local stores
  await expect(
    client.request("models.authRefresh", {
      agentId: "main",
      operation: "update",
      clearTransientCooldowns: true,
    }),
  ).resolves.toEqual({ refreshed: true });

  localPersisted = loadPersistedAuthProfileStore(state.agentDir());
  expect(localPersisted?.usageStats?.[localProfileId]?.cooldownReason).toBeUndefined();
  expect(localPersisted?.usageStats?.[localProfileId]?.cooldownUntil).toBeUndefined();
  expect(localPersisted?.usageStats?.[localProfileId]?.disabledReason).toBe("billing");

  let sharedPersisted: AuthProfileStore | null = null;
  runOpenClawStateWriteTransaction((database) => {
    sharedPersisted = loadPersistedAuthProfileStore(undefined, { database });
  });
  expect(sharedPersisted?.usageStats?.[sharedProfileId]?.cooldownReason).toBeUndefined();
  expect(sharedPersisted?.usageStats?.[sharedProfileId]?.cooldownUntil).toBeUndefined();
  expect(sharedPersisted?.usageStats?.[sharedProfileId]?.disabledReason).toBe("billing");
});

it("publishes saved credentials and persisted removals before acknowledging an administrator", async () => {
  await using state = await createModelsTestState("models-auth-refresh");
  const token = "auth-refresh-integration-token";
  const cfg = modelsTestConfig(state, token, {
    skills: {
      entries: {
        unavailable: {
          apiKey: { source: "store", provider: "default", id: "MISSING_SKILL_KEY" },
        },
      },
    },
  });
  await state.writeConfig(cfg);
  await using gateway = await startModelsGateway(state, cfg, token);
  await gateway.server.startupSettled;
  const { client, port } = gateway;
  const unrelatedWarnings = getActiveSecretsRuntimeSnapshot()?.warnings.filter(
    (warning) => warning.path === "skills.entries.unavailable.apiKey",
  );
  expect(unrelatedWarnings).toHaveLength(1);
  await expect(client.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
    expect.objectContaining({ providers: expect.any(Array) }),
  );
  // Change durable ownership without updating the pinned shared-store location.
  writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
  runOpenClawStateWriteTransaction((database) => {
    writePersistedAuthProfileStoreRaw(
      tokenStore("auth-refresh-shared", "proof"),
      undefined,
      database,
    );
  });
  await refresh(client, "login", "auth-refresh-shared:proof");
  const agentDatabasePath = await state.writeAuthProfiles(
    tokenStore("auth-refresh-proof", "local"),
  );
  await refresh(client, "login", "auth-refresh-proof:local");
  await writeAuthStoreExternally(state, agentDatabasePath, null);
  await refresh(client, "logout");
  const refreshed = await client.request<ModelAuthStatusResult>("models.authStatus", {
    agentId: "main",
  });
  const profileIds = refreshed.providers.flatMap(({ profiles }) =>
    profiles.map(({ profileId }) => profileId),
  );
  expect(profileIds).not.toContain("auth-refresh-proof:local");
  expect(profileIds).toContain("auth-refresh-shared:proof");
  expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(unrelatedWarnings);
  await using reader = await connectModelsReader(port, token);
  await expect(
    reader.request("models.authRefresh", { agentId: "main", operation: "update" }),
  ).rejects.toThrow("operator.admin");
  await expect(reader.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
    expect.objectContaining({ providers: expect.any(Array) }),
  );
});
