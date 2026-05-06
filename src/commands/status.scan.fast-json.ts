import type { OpenClawConfig } from "../config/types.js";
import { hasConfiguredChannelsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import type { RuntimeEnv } from "../runtime.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import {
  resolveDefaultMemoryStorePath,
  resolveStatusMemoryStatusSnapshot,
} from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

type StatusJsonScanPolicy = {
  commandName: string;
  allowMissingConfigFastPath?: boolean;
  includeChannelSummary?: boolean;
  includeTaskSummary?: boolean;
  includeUpdateCheck?: boolean;
  includeUpdateFetch?: boolean;
  includeUpdateRegistry?: boolean;
  includeLocalStatusRpcFallback?: boolean;
  gatewayProbeTimeoutMs?: number;
  resolveHasConfiguredChannels: (cfg: OpenClawConfig, sourceConfig: OpenClawConfig) => boolean;
  resolveMemory: Parameters<typeof executeStatusScanFromOverview>[0]["resolveMemory"];
};

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
    includeUpdateCheck: policy.includeUpdateCheck,
    includeUpdateFetch: policy.includeUpdateFetch,
    includeUpdateRegistry: policy.includeUpdateRegistry,
    includeLocalStatusRpcFallback: policy.includeLocalStatusRpcFallback,
    gatewayProbeTimeoutMs: policy.gatewayProbeTimeoutMs,
  });
  return await executeStatusScanFromOverview({
    overview,
    runtime,
    summary: {
      includeChannelSummary: policy.includeChannelSummary,
      includeTaskSummary: policy.includeTaskSummary,
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
    includeTaskSummary: opts.all === true,
    includeUpdateCheck: opts.all === true,
    includeUpdateFetch: opts.all === true,
    includeUpdateRegistry: opts.all === true,
    includeLocalStatusRpcFallback: opts.all === true,
    gatewayProbeTimeoutMs: opts.all === true ? undefined : Math.min(1000, opts.timeoutMs ?? 1000),
    resolveHasConfiguredChannels: (cfg, sourceConfig) =>
      hasConfiguredChannelsForReadOnlyScope({
        config: cfg,
        activationSourceConfig: sourceConfig,
        env: process.env,
        includePersistedAuthState: false,
      }),
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
