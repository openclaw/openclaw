import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { SHARED_AUTH_STORE_STATE_KEY } from "../../agents/auth-profiles/sqlite-json.js";
import { writePersistedAuthProfileStoreRaw } from "../../agents/auth-profiles/sqlite.js";
import { getRuntimeConfig, resolveConfigPath, resolveStateDir } from "../../config/config.js";
import { isPathInside } from "../../infra/path-guards.js";
import { getActiveSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { deleteSecretStoreEntry, writeSecretStoreEntry } from "../../secrets/store/secret-store.js";
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

function expectIsolatedState(state: Awaited<ReturnType<typeof createModelsTestState>>) {
  expect([process.env.OPENCLAW_HOME, resolveStateDir(), resolveConfigPath()]).toEqual([
    state.home,
    state.stateDir,
    state.configPath,
  ]);
  for (const resolved of [state.home, resolveStateDir(), resolveConfigPath()]) {
    expect(isPathInside(state.root, resolved)).toBe(true);
  }
}

function expectProfile(
  client: Awaited<ReturnType<typeof startModelsGateway>>["client"],
  provider: string,
  profileId: string,
) {
  return expect(client.request("models.authStatus", { agentId: "main" })).resolves.toMatchObject({
    providers: expect.arrayContaining([
      expect.objectContaining({
        provider,
        profiles: expect.arrayContaining([expect.objectContaining({ profileId })]),
      }),
    ]),
  });
}

describe("models.authRefresh", () => {
  it("publishes and clears quoted provider warnings through registered refresh", async () => {
    await using state = await createModelsTestState("models-auth-refresh-quoted");
    const token = "quoted-auth-refresh-token";
    const providerNames = ["plain", "123", "local.service"];
    const providerPaths = [
      "models.providers.plain.apiKey",
      'models.providers["123"].apiKey',
      'models.providers["local.service"].apiKey',
    ];
    const cfg = modelsTestConfig(state, token, {
      models: {
        providers: Object.fromEntries(
          providerNames.map((provider) => [
            provider,
            {
              baseUrl: "https://example.invalid/v1",
              apiKey: { source: "store", provider: "default", id: "REFRESH_PROVIDER_KEY" },
              models: [],
            },
          ]),
        ),
      },
      skills: {
        entries: {
          unavailable: {
            apiKey: { source: "store", provider: "default", id: "MISSING_SKILL_KEY" },
          },
        },
      },
    });
    const saveProviderKey = (value: string) =>
      writeSecretStoreEntry({
        scope: { kind: "team" },
        name: "REFRESH_PROVIDER_KEY",
        value,
        kind: "secret",
        updatedBy: "test",
        database: { env: state.env },
      });
    expectIsolatedState(state);
    await saveProviderKey("initial-provider-credential");
    await using gateway = await startModelsGateway(state, cfg, token);
    await gateway.server.startupSettled;
    const { client } = gateway;
    const unrelatedWarnings = expectDefined(
      getActiveSecretsRuntimeSnapshot(),
      "Gateway published its secrets runtime",
    ).warnings.filter((warning) => warning.path === "skills.entries.unavailable.apiKey");
    expect(unrelatedWarnings).toHaveLength(1);
    await deleteSecretStoreEntry({
      scope: { kind: "team" },
      name: "REFRESH_PROVIDER_KEY",
      database: { env: state.env },
    });
    await expect(
      client.request("models.authRefresh", { agentId: "main", operation: "update" }),
    ).resolves.toEqual({ refreshed: true });
    for (const providerPath of providerPaths) {
      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toContainEqual(
        expect.objectContaining({ path: providerPath }),
      );
    }
    expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(
      expect.arrayContaining(unrelatedWarnings),
    );

    await saveProviderKey("recovered-provider-credential");
    await expect(
      client.request("models.authRefresh", { agentId: "main", operation: "update" }),
    ).resolves.toEqual({ refreshed: true });
    expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(unrelatedWarnings);
    for (const provider of providerNames) {
      expect(getRuntimeConfig().models?.providers?.[provider]?.apiKey).toBe(
        "recovered-provider-credential",
      );
    }
  });

  it("publishes saved credentials and persisted removals before acknowledging an administrator", async () => {
    await using state = await createModelsTestState("models-auth-refresh");
    const token = "auth-refresh-integration-token";
    const cfg = modelsTestConfig(state, token);
    await state.writeConfig(cfg);
    expectIsolatedState(state);
    await using gateway = await startModelsGateway(state, cfg, token);
    await gateway.server.startupSettled;
    const { client, port } = gateway;
    await expect(client.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
      expect.objectContaining({ providers: expect.any(Array) }),
    );
    // Change durable ownership without updating the pinned shared-store location.
    writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
    runOpenClawStateWriteTransaction((database) => {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "auth-refresh-shared:proof": {
              type: "token",
              provider: "auth-refresh-shared",
              token: "synthetic-shared-token",
            },
          },
        },
        undefined,
        database,
      );
    });
    await expect(
      client.request("models.authRefresh", { agentId: "main", operation: "login" }),
    ).resolves.toEqual({ refreshed: true });
    await expectProfile(client, "auth-refresh-shared", "auth-refresh-shared:proof");
    const agentDatabasePath = await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "auth-refresh-proof:local": {
          type: "token",
          provider: "auth-refresh-proof",
          token: "saved-fixture-token",
        },
      },
    });
    await expect(
      client.request("models.authRefresh", { agentId: "main", operation: "login" }),
    ).resolves.toEqual({ refreshed: true });
    await expectProfile(client, "auth-refresh-proof", "auth-refresh-proof:local");
    await writeAuthStoreExternally(state, agentDatabasePath, null);
    await expect(
      client.request("models.authRefresh", { agentId: "main", operation: "logout" }),
    ).resolves.toEqual({ refreshed: true });
    const refreshed = await client.request<ModelAuthStatusResult>("models.authStatus", {
      agentId: "main",
    });
    const profileIds = refreshed.providers.flatMap(({ profiles }) =>
      profiles.map(({ profileId }) => profileId),
    );
    expect(profileIds).not.toContain("auth-refresh-proof:local");
    expect(profileIds).toContain("auth-refresh-shared:proof");
    await using reader = await connectModelsReader(port, token);
    await expect(
      reader.request("models.authRefresh", { agentId: "main", operation: "update" }),
    ).rejects.toThrow("operator.admin");
    await expect(reader.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
      expect.objectContaining({ providers: expect.any(Array) }),
    );
  });
});
