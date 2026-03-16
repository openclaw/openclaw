import { CONFIG_PATH, type ConfigFileSnapshot, type OpenClawConfig } from "../config/config.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import {
  startGatewayConfigReloader,
  type GatewayConfigReloader,
  type GatewayReloadPlan,
} from "./config-reload.js";

type RuntimeSecretsState = {
  getActive: () => PreparedSecretsRuntimeSnapshot | null;
  activate: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
  clear: () => void;
};

type StartGatewayRuntimeConfigReloaderParams = {
  initialConfig: OpenClawConfig;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  activateRuntimeSecrets: (
    config: OpenClawConfig,
    params: { reason: "reload" | "restart-check"; activate: boolean },
  ) => Promise<PreparedSecretsRuntimeSnapshot>;
  applyHotReload: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>;
  requestGatewayRestart: (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void;
  secretsRuntime: RuntimeSecretsState;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath?: string;
  startGatewayConfigReloaderFn?: typeof startGatewayConfigReloader;
};

export function startGatewayRuntimeConfigReloader(
  params: StartGatewayRuntimeConfigReloaderParams,
): GatewayConfigReloader {
  const startReloader = params.startGatewayConfigReloaderFn ?? startGatewayConfigReloader;
  return startReloader({
    initialConfig: params.initialConfig,
    readSnapshot: params.readSnapshot,
    onHotReload: async (plan, nextConfig) => {
      const previousSnapshot = params.secretsRuntime.getActive();
      const prepared = await params.activateRuntimeSecrets(nextConfig, {
        reason: "reload",
        activate: true,
      });
      try {
        await params.applyHotReload(plan, prepared.config);
      } catch (err) {
        if (previousSnapshot) {
          params.secretsRuntime.activate(previousSnapshot);
        } else {
          params.secretsRuntime.clear();
        }
        throw err;
      }
    },
    onRestart: async (plan, nextConfig) => {
      await params.activateRuntimeSecrets(nextConfig, {
        reason: "restart-check",
        activate: false,
      });
      params.requestGatewayRestart(plan, nextConfig);
    },
    log: params.log,
    watchPath: params.watchPath ?? CONFIG_PATH,
  });
}
