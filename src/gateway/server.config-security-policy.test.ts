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
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

describe("config security policy before persistence", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  const token = "config-security-policy-test-token";
  const makeConfig = (gateway: NonNullable<OpenClawConfig["gateway"]>) =>
    ({
      agents: { defaults: { workspace: state.workspaceDir } },
      logging: { level: "silent", consoleLevel: "silent" },
      gateway: { mode: "local", auth: { mode: "token", token }, ...gateway },
    }) satisfies OpenClawConfig;

  async function start(
    cfg: OpenClawConfig,
    options: Pick<Parameters<typeof connectGatewayClient>[0], "scopes" | "onHelloOk">,
    recover = false,
  ) {
    await state.writeConfig(cfg);
    const port = await getFreePort();
    server = await startGatewayServer(port, {
      hotReloadRecovery: recover ? () => ({ status: "emitted" }) : undefined,
    });
    await server.startupSettled;
    client = await connectGatewayClient({ url: `ws://127.0.0.1:${port}`, token, ...options });
    return client;
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "gateway-config-security-policy",
      env: {
        ...KERNEL_TEST_ENV,
        VITEST: process.env.VITEST,
        // Minimal boot skips the managed writer subscription that owns pre-commit validation.
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        CONFIG_PROVENANCE_API_KEY: "synthetic-included-env-key",
      },
    });
  });

  it("keeps authored provenance out of valid and invalid read-scoped config.get responses", async () => {
    const inlineKey = "synthetic-provider-key";
    const envKey = "synthetic-included-env-key";
    const provider = (apiKey: string) => ({ baseUrl: "https://example.test", apiKey, models: [] });
    const models = {
      providers: {
        inline: provider(inlineKey),
        referenced: provider("${CONFIG_PROVENANCE_API_KEY}"),
      },
    };
    await state.writeJson("models.json", models);
    let grantedScopes: string[] | undefined;
    const reader = await start(
      makeConfig({ controlUi: { enabled: false }, reload: { mode: "off" } }),
      {
        scopes: ["operator.read"],
        onHelloOk: (hello) => {
          grantedScopes = hello.auth.scopes;
        },
      },
    );
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
        const response = await reader.request("config.get", {});
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
    { method: "config.apply", disableUi: true },
  ])(
    "validates $method clearing LAN origins (disableUi=$disableUi)",
    async ({ method, disableUi }) => {
      await state.writeText("control-ui/index.html", "<!doctype html><title>Control UI</title>");
      const initialConfig = makeConfig({
        bind: "lan",
        controlUi: {
          enabled: true,
          root: state.statePath("control-ui"),
          allowedOrigins: ["https://control.example.test"],
        },
        reload: { mode: "hybrid" },
      });
      const writer = await start(initialConfig, { scopes: ["operator.admin"] }, true);
      const before = await writer.request<{ hash: string }>("config.get", {});
      const beforeBytes = await fs.readFile(state.configPath, "utf8");
      const controlUi = { ...(disableUi ? { enabled: false } : {}), allowedOrigins: [] };
      const nextConfig = structuredClone(initialConfig);
      nextConfig.gateway.controlUi = { ...nextConfig.gateway.controlUi, ...controlUi };
      const outcome = writer.request(method, {
        baseHash: before.hash,
        raw: JSON.stringify(method === "config.patch" ? { gateway: { controlUi } } : nextConfig),
        ...(method === "config.patch"
          ? { replacePaths: ["gateway.controlUi.allowedOrigins"] }
          : {}),
      });
      if (disableUi) {
        await expect(outcome).resolves.toMatchObject({
          sentinel: { payload: { stats: { requiresRestart: false } } },
        });
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
          gateway: { controlUi: { enabled: false, allowedOrigins: [] } },
        });
      } else {
        await expect(outcome).rejects.toMatchObject({
          message: expect.stringContaining("non-loopback Control UI requires"),
        });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeBytes);
        expect((await writer.request<{ hash: string }>("config.get", {})).hash).toBe(before.hash);
      }
    },
  );
});
