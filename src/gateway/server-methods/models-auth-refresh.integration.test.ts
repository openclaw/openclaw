import { expect, it } from "vitest";
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
