import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { resolveEffectiveCompactionMode } from "../agents/agent-settings.js";
import { getRuntimeConfig } from "../config/io.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { startGatewayServerCore } from "./server-start.js";

it("preserves computed defaults from cold startup through a live config reload", async () => {
  const token = "provider-defaults-startup-token";
  const state = await createOpenClawTestState({
    label: "provider-defaults-reload",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
  });
  const sourceConfig = {
    agents: {
      entries: { main: { default: true } },
      defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
    },
    models: { providers: { anthropic: { apiKey: "synthetic-api-key" } } },
    plugins: { allow: ["anthropic"] },
    gateway: { auth: { mode: "token", token } },
  };
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  try {
    await state.writeConfig(sourceConfig);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "anthropic:fixture": {
          type: "api_key",
          provider: "anthropic",
          key: "synthetic-api-key",
        },
      },
    });
    server = await startGatewayServerCore(await getFreePort(), {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
    });
    await server.startupSettled;
    const initialConfig = getRuntimeConfig();
    expect(initialConfig.plugins?.entries?.anthropic?.enabled).toBe(true);
    expect(resolveEffectiveCompactionMode(initialConfig)).toBe("safeguard");
    expect(initialConfig.models?.providers?.anthropic?.models).toEqual([]);
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(sourceConfig);

    const nextSourceConfig = { ...sourceConfig, logging: { level: "warn" } };
    await state.writeConfig(nextSourceConfig);
    await expect.poll(() => getRuntimeConfig().logging?.level, { timeout: 30_000 }).toBe("warn");
    const reloadedConfig = getRuntimeConfig();
    expect(reloadedConfig).not.toBe(initialConfig);
    expect(reloadedConfig.plugins?.entries?.anthropic?.enabled).toBe(true);
    expect(resolveEffectiveCompactionMode(reloadedConfig)).toBe("safeguard");
    expect(reloadedConfig.models?.providers?.anthropic?.models).toEqual([]);
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(nextSourceConfig);
  } finally {
    await server?.close({ reason: "runtime defaults reload test complete" });
    await state.cleanup();
  }
}, 90_000);
