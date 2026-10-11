import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRecord } from "../utils.js";
import type { StatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusJsonScanResult } from "./status.scan-result.ts";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const STATUS_JSON_CHANNEL_ENV_PREFIXES = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter(
  (entry) => entry.configurable !== false,
).map((entry) => `${entry.channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`);
const STATUS_JSON_CHANNEL_ENV_VARS = new Set(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false).flatMap(
    (entry) => entry.channelEnvVars ?? [],
  ),
);

function hasExplicitStatusJsonChannelConfig(cfg: OpenClawConfig): boolean {
  if (!isRecord(cfg.channels)) {
    return false;
  }
  // `enabled` alone can be a default scaffold; require another configured field.
  return Object.entries(cfg.channels).some(
    ([key, value]) =>
      !IGNORED_CHANNEL_CONFIG_KEYS.has(key) &&
      isRecord(value) &&
      Object.keys(value).some((field) => field !== "enabled"),
  );
}

function hasStatusJsonChannelEnvConfig(): boolean {
  const env = process.env;
  return Object.entries(env).some(
    ([key, value]) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      (STATUS_JSON_CHANNEL_ENV_VARS.has(key) ||
        STATUS_JSON_CHANNEL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))),
  );
}

export async function scanStatusJsonFast(
  opts: StatusGatewayProbeBudget & {
    all?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<StatusJsonScanResult> {
  const online = await (await import("./status.scan.gateway.js")).scanStatusJsonGateway(opts);
  if (online.scan) {
    return online.scan;
  }
  const overview = await collectStatusScanOverview({
    env: process.env,
    commandName: "status --json",
    opts,
    showSecrets: false,
    runtime,
    allowMissingConfigFastPath: true,
    resolveHasConfiguredChannels: (cfg) =>
      hasExplicitStatusJsonChannelConfig(cfg) || hasStatusJsonChannelEnvConfig(),
    includeChannelsData: false,
    fetchGitUpdate: opts.all === true,
    includeRegistryUpdate: opts.all === true,
    includeLocalStatusRpcFallback: opts.all === true,
    gatewaySnapshot: online.gatewaySnapshot,
  });
  const pluginCompatibility = opts.all
    ? await import("../plugins/status.js").then(({ buildPluginCompatibilitySnapshotNotices }) =>
        buildPluginCompatibilitySnapshotNotices({ config: overview.cfg }),
      )
    : [];
  return await executeStatusScanFromOverview({
    overview,
    includeMemory: opts.all,
    pluginCompatibility,
  });
}
