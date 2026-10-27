import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { resolveEffectiveCompactionMode } from "../agents/agent-settings.js";
import { writeConfigFile } from "../config/config.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { startGatewayServerCore } from "./server-start.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { createPluginEnabledGatewayTestEnv } from "./test-helpers.env.js";

it("preserves computed defaults from cold startup through a live config reload", async () => {
  const token = "provider-defaults-startup-token";
  const state = await createOpenClawTestState({
    label: "provider-defaults-reload",
    env: createPluginEnabledGatewayTestEnv(),
  });
  const sourceConfig: OpenClawConfig = {
    agents: {
      entries: { main: {} },
      defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
    },
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          models: [],
          apiKey: "synthetic-api-key",
        },
      },
    },
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
    const kernel = await captureGatewayKernel(async () => {
      server = await startGatewayServerCore(await getFreePort(), {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
    });
    await server!.startupSettled;
    const initialConfig = getRuntimeConfig();
    expect(initialConfig).not.toBe(kernel.cfgAtStart);
    expect(kernel.gatewayRequestContext.getCommittedRuntimeConfig?.()).toBe(initialConfig);
    expect(initialConfig.plugins?.entries?.anthropic?.enabled).toBe(true);
    expect(resolveEffectiveCompactionMode(initialConfig)).toBe("safeguard");
    expect(initialConfig.models?.providers?.anthropic?.models).toEqual([]);
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(sourceConfig);

    const nextSourceConfig: OpenClawConfig = { ...sourceConfig, logging: { level: "warn" } };
    await state.writeConfig(nextSourceConfig);
    await expect.poll(() => getRuntimeConfig().logging?.level, { timeout: 30_000 }).toBe("warn");
    const reloadedConfig = getRuntimeConfig();
    expect(reloadedConfig).not.toBe(initialConfig);
    expect(reloadedConfig.plugins?.entries?.anthropic?.enabled).toBe(true);
    expect(resolveEffectiveCompactionMode(reloadedConfig)).toBe("safeguard");
    expect(reloadedConfig.models?.providers?.anthropic?.models).toEqual([]);
    const accessConfig = {
      ...nextSourceConfig,
      plugins: {
        allow: ["anthropic", "muse"],
        entries: { muse: { enabled: true } },
      },
    };
    await expect(
      writeConfigFile(accessConfig, {
        runtimeRefresh: { requireImmediateApplication: true },
      }),
    ).rejects.toThrow("Update or enable the selected provider plugin");
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(nextSourceConfig);
    await writeConfigFile(accessConfig);
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject(accessConfig);
    expect(getRuntimeConfig().agents?.defaults?.model).toEqual(
      initialConfig.agents?.defaults?.model,
    );
  } finally {
    await server?.close({ reason: "runtime defaults reload test complete" });
    await state.cleanup();
  }
}, 90_000);
