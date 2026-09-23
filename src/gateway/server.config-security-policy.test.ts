import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetLogger } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";
import { startGatewayServerCore as startGatewayServer } from "./server-start.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

describe("config security policy before persistence", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "gateway-config-security-policy",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        // Minimal boot skips the managed writer subscription that owns pre-commit validation.
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        CONFIG_PROVENANCE_API_KEY: "synthetic-included-env-key",
      },
    });
  });

  it("keeps authored provenance out of valid and invalid read-scoped config.get responses", async () => {
    const token = "synthetic-gateway-auth-token";
    const inlineKey = "synthetic-provider-key";
    const envKey = "synthetic-included-env-key";
    const models = {
      providers: {
        inline: { baseUrl: "https://example.test", apiKey: inlineKey, models: [] },
        referenced: {
          baseUrl: "https://example.test",
          apiKey: "${CONFIG_PROVENANCE_API_KEY}",
          models: [],
        },
      },
    };
    await state.writeJson("models.json", models);
    const initialConfig = {
      agents: { defaults: { workspace: state.workspaceDir } },
      logging: { level: "silent", consoleLevel: "silent" },
      gateway: {
        mode: "local",
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        reload: { mode: "off" },
      },
    };
    await state.writeConfig(initialConfig);
    const port = await getFreePort();
    server = await startGatewayServer(port);
    await server.startupSettled;
    let grantedScopes: string[] | undefined;
    client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      scopes: ["operator.read"],
      onHelloOk: (hello) => {
        grantedScopes = hello.auth.scopes;
      },
    });
    expect(grantedScopes).toEqual(["operator.read"]);

    // Keep one admitted reader while the on-disk snapshot becomes invalid.
    // Direct fixture writes must invalidate cached config.get responses.
    for (const useInclude of [false, true]) {
      for (const valid of [true, false]) {
        await state.writeConfig({
          gateway: { reload: { mode: "off" } },
          models: useInclude ? { $include: "models.json" } : models,
          ...(valid ? {} : { nodeHost: { browserProxy: { enabled: "invalid" } } }),
        });
        invalidateConfigGetResponseCache();
        const snapshot = await readConfigFileSnapshot({ observe: false });
        expect(snapshot.valid).toBe(valid);
        expect(snapshot.authoredConfig?.models).toEqual(models);
        expect(snapshot.sourceConfigBeforeMigrations?.models?.providers?.referenced?.apiKey).toBe(
          envKey,
        );
        const before = structuredClone(snapshot);
        const response = await client.request("config.get", {});
        const serialized = JSON.stringify(response);

        expect(response.valid).toBe(valid);
        expect(response).not.toHaveProperty("authoredConfig");
        expect(response).not.toHaveProperty("sourceConfigBeforeMigrations");
        for (const canary of [token, inlineKey, envKey]) {
          expect(serialized).not.toContain(canary);
        }
        expect(snapshot).toEqual(before);
        expect(await readConfigFileSnapshot({ observe: false })).toMatchObject({
          authoredConfig: snapshot.authoredConfig,
          sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
        });
      }
    }
  });

  afterEach(async () => {
    if (client) {
      await disconnectGatewayClient(client);
      client = undefined;
    }
    await server?.close();
    server = undefined;
    await state.cleanup();
    resetLogger();
    clearPluginMetadataLifecycleCaches();
  });

  it.each([
    { method: "config.patch", disableUi: false },
    { method: "config.apply", disableUi: false },
    { method: "config.patch", disableUi: true },
    { method: "config.apply", disableUi: true },
  ])(
    "validates $method clearing LAN origins (disableUi=$disableUi)",
    async ({ method, disableUi }) => {
      const token = "config-security-policy-test-token";
      await state.writeText("control-ui/index.html", "<!doctype html><title>Control UI</title>");
      const initialConfig: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        logging: { level: "silent", consoleLevel: "silent" },
        gateway: {
          mode: "local",
          bind: "lan",
          auth: { mode: "token", token },
          controlUi: {
            enabled: true,
            root: state.statePath("control-ui"),
            allowedOrigins: ["https://control.example.test"],
          },
          reload: { mode: "hybrid" },
        },
      };
      await state.writeConfig(initialConfig);
      const port = await getFreePort();
      server = await startGatewayServer(port, {
        hotReloadRecovery: () => ({ status: "emitted" }),
      });
      await server.startupSettled;
      client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        scopes: ["operator.admin"],
      });
      const before = await client.request<{ hash: string }>("config.get", {});
      const beforeBytes = await fs.readFile(state.configPath, "utf8");
      const controlUi = {
        ...(disableUi ? { enabled: false } : {}),
        allowedOrigins: [],
      };
      const outcome = await client
        .request(method, {
          baseHash: before.hash,
          raw: JSON.stringify(
            method === "config.patch"
              ? { gateway: { controlUi } }
              : {
                  ...initialConfig,
                  gateway: {
                    ...initialConfig.gateway,
                    controlUi: { ...initialConfig.gateway?.controlUi, ...controlUi },
                  },
                },
          ),
          ...(method === "config.patch"
            ? { replacePaths: ["gateway.controlUi.allowedOrigins"] }
            : {}),
        })
        .then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
      if (disableUi) {
        expect(outcome).toMatchObject({
          ok: true,
          value: { sentinel: { payload: { stats: { requiresRestart: false } } } },
        });
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
          gateway: { controlUi: { enabled: false, allowedOrigins: [] } },
        });
      } else {
        expect((await fs.readFile(state.configPath, "utf8")) === beforeBytes).toBe(true);
        expect(outcome).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("non-loopback Control UI requires") },
        });
        expect((await client.request<{ hash: string }>("config.get", {})).hash).toBe(before.hash);
      }
    },
  );
});
