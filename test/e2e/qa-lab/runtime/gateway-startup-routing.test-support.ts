import fs from "node:fs/promises";
import path from "node:path";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";

export function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
}

export async function prepareRecoveryHome(home: string, token: string, channels = false) {
  const stateDir = path.join(home, ".openclaw");
  const workspaceDir = path.join(home, "workspace");
  const bundledPluginsDir = path.join(home, "empty-bundled-plugins");
  const directories = [stateDir, bundledPluginsDir, ...(channels ? [workspaceDir] : [])];
  await Promise.all(directories.map((dir) => fs.mkdir(dir, { recursive: true })));
  const env = {
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_SKIP_CHANNELS: channels ? undefined : "1",
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "0",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    ...(channels ? { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined } : {}),
  };
  const envSnapshot = captureEnv([
    ...Object.keys(env),
    ...(channels
      ? ["OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN"]
      : []),
  ]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      deleteTestEnvValue(key);
    } else {
      setTestEnvValue(key, value);
    }
  }
  return { stateDir, workspaceDir, configPath: path.join(stateDir, "openclaw.json"), envSnapshot };
}
