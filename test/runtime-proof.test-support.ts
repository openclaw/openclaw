import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { AgentDefaultsConfig } from "../src/config/types.agent-defaults.js";
import type { ModelProviderConfig } from "../src/config/types.models.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import type { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
export { listenLoopback as listenProofProvider } from "./helpers/gateway-integration-fixtures.js";

type Gateway = Awaited<ReturnType<typeof startGatewayWithClient>>;
type Provider = { providerId: string; modelRef: string; config: ModelProviderConfig };

export function useRuntimeProofFixture(hook: Parameters<typeof useAutoCleanupTempDirTracker>[0]) {
  const tempDirs = useAutoCleanupTempDirTracker(hook);
  return async (prefix: string, token: string, skipCron = "1") => {
    const tempHome = tempDirs.make(prefix);
    const stateDir = path.join(tempHome, ".openclaw");
    const workspace = path.join(tempHome, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
    const env = {
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: skipCron,
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const envSnapshot = captureEnv([...Object.keys(env), "OPENCLAW_GATEWAY_URL"]);
    await Promise.all(
      [workspace, bundledPluginsDir, stateDir].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    for (const [key, value] of Object.entries(env)) {
      setTestEnvValue(key, value);
    }
    return {
      stateDir,
      workspaceDir: workspace,
      configPath,
      config(
        { providerId, modelRef, config }: Provider,
        defaults: AgentDefaultsConfig = {},
        extra: OpenClawConfig = {},
      ): OpenClawConfig {
        return {
          agents: {
            defaults: { workspace, skipBootstrap: true, model: { primary: modelRef }, ...defaults },
            entries: { main: {} },
          },
          models: { mode: "replace", providers: { [providerId]: config } },
          gateway: { auth: { mode: "token", token } },
          ...extra,
        };
      },
      async close(gateway: Gateway | undefined, provider: Server | undefined, force = false) {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (provider?.listening) {
          if (force) {
            provider.closeAllConnections();
          }
          await new Promise<void>((resolve) => {
            provider.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearSessionStoreCacheForTest();
      },
    };
  };
}
