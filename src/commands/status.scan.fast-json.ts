import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { isRecord } from "../utils.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import {
  resolveDefaultMemoryStorePath,
  resolveStatusMemoryStatusSnapshot,
} from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

const channelConfigPresenceModuleLoader = createLazyImportLoader(
  () => import("../channels/config-presence.js"),
);

type StatusJsonScanPolicy = {
  commandName: string;
  allowMissingConfigFastPath?: boolean;
  includeChannelSummary?: boolean;
  resolveHasConfiguredChannels: (
    cfg: OpenClawConfig,
    sourceConfig: OpenClawConfig,
  ) => boolean | Promise<boolean>;
  resolveMemory: Parameters<typeof executeStatusScanFromOverview>[0]["resolveMemory"];
};

function hasMeaningfulStatusJsonChannelConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key !== "enabled");
}

function hasExplicitStatusJsonChannelConfig(cfg: OpenClawConfig): boolean {
  if (!isRecord(cfg.channels)) {
    return false;
  }
  for (const [key, value] of Object.entries(cfg.channels)) {
    if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
      continue;
    }
    if (hasMeaningfulStatusJsonChannelConfig(value)) {
      return true;
    }
  }
  return false;
}

async function hasPotentialConfiguredChannelsForStatusJson(cfg: OpenClawConfig): Promise<boolean> {
  if (hasExplicitStatusJsonChannelConfig(cfg)) {
    return true;
  }
  const { hasPotentialConfiguredChannels } = await channelConfigPresenceModuleLoader.load();
  return hasPotentialConfiguredChannels(cfg, process.env, {
    includePersistedAuthState: false,
  });
}

export async function scanStatusJsonWithPolicy(
  opts: {
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
  policy: StatusJsonScanPolicy,
): Promise<StatusScanResult> {
  const overview = await collectStatusScanOverview({
    commandName: policy.commandName,
    opts,
    showSecrets: false,
    runtime,
    allowMissingConfigFastPath: policy.allowMissingConfigFastPath,
    resolveHasConfiguredChannels: policy.resolveHasConfiguredChannels,
    includeChannelsData: false,
    includeChannelSecretTargets: false,
    skipConfigPluginValidation: true,
  });
  return await executeStatusScanFromOverview({
    overview,
    runtime,
    summary: {
      includeChannelSummary: policy.includeChannelSummary,
    },
    resolveMemory: policy.resolveMemory,
    channelIssues: [],
    channels: { rows: [], details: [] },
    pluginCompatibility: [],
  });
}

export async function scanStatusJsonFast(
  opts: {
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  return await scanStatusJsonWithPolicy(opts, runtime, {
    commandName: "status --json",
    allowMissingConfigFastPath: true,
    includeChannelSummary: false,
    resolveHasConfiguredChannels: (cfg) => hasPotentialConfiguredChannelsForStatusJson(cfg),
    resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
      opts.all
        ? await resolveStatusMemoryStatusSnapshot({
            cfg,
            agentStatus,
            memoryPlugin,
            requireDefaultStore: resolveDefaultMemoryStorePath,
          })
        : null,
  });
}
