import { describe, expect, it } from "vitest";
import { SHARED_AUTH_STORE_STATE_KEY } from "../../agents/auth-profiles/path-resolve.js";
import { writePersistedAuthProfileStoreRaw } from "../../agents/auth-profiles/sqlite.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";

describe("models.authRefresh", () => {
  it("publishes saved agent credentials before acknowledging an administrator", async () => {
    const state = await createOpenClawTestState({
      label: "models-auth-refresh",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const token = "auth-refresh-integration-token";
    const cfg = {
      agents: { list: [{ id: "main", workspace: state.workspaceDir }] },
      plugins: { enabled: false },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    try {
      const { client, server, port } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        await expect(client.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
          expect.objectContaining({ providers: expect.any(Array) }),
        );
        // An external writer changes durable ownership without updating this process's cache.
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
        await expect(client.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
          expect.objectContaining({
            providers: expect.arrayContaining([
              expect.objectContaining({
                provider: "auth-refresh-shared",
                profiles: expect.arrayContaining([
                  expect.objectContaining({ profileId: "auth-refresh-shared:proof" }),
                ]),
              }),
            ]),
          }),
        );
        await state.writeAuthProfiles({
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
        await expect(client.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
          expect.objectContaining({
            providers: expect.arrayContaining([
              expect.objectContaining({
                provider: "auth-refresh-proof",
                profiles: expect.arrayContaining([
                  expect.objectContaining({ profileId: "auth-refresh-proof:local" }),
                ]),
              }),
            ]),
          }),
        );
        const reader = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          scopes: ["operator.read"],
        });
        try {
          await expect(
            reader.request("models.authRefresh", { agentId: "main", operation: "update" }),
          ).rejects.toThrow("operator.admin");
          await expect(reader.request("models.authStatus", { agentId: "main" })).resolves.toEqual(
            expect.objectContaining({ providers: expect.any(Array) }),
          );
        } finally {
          await disconnectGatewayClient(reader);
        }
      } finally {
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      await state.cleanup();
    }
  });
});
