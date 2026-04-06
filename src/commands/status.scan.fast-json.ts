import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolveDefaultMemoryStorePath,
  resolveStatusMemoryStatusSnapshot,
} from "./status.scan-memory.ts";
import {
  resolveStatusSummaryFromOverview,
  collectStatusScanOverview,
} from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";
import { buildStatusScanResult } from "./status.scan-result.ts";
import { resolveMemoryPluginStatus } from "./status.scan.shared.js";
let pluginRegistryModulePromise: Promise<typeof import("../cli/plugin-registry.js")> | undefined;

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("../cli/plugin-registry.js");
  return pluginRegistryModulePromise;
}

type StatusJsonScanPolicy = {
  commandName: string;
  allowMissingConfigFastPath?: boolean;
  resolveHasConfiguredChannels: (
    cfg: Parameters<typeof hasPotentialConfiguredChannels>[0],
  ) => boolean;
  resolveMemory: Parameters<typeof scanStatusJsonCore>[0]["resolveMemory"];
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
  });
  if (overview.hasConfiguredChannels) {
    const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
    const { loggingState } = await import("../logging/state.js");
    const previousForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = true;
    try {
      ensurePluginRegistryLoaded({ scope: "configured-channels" });
    } finally {
      loggingState.forceConsoleToStderr = previousForceStderr;
    }
  }

  const memoryPlugin = resolveMemoryPluginStatus(overview.cfg);
  const memory = await policy.resolveMemory({
    cfg: overview.cfg,
    agentStatus: overview.agentStatus,
    memoryPlugin,
    runtime,
  });
  const summary = await resolveStatusSummaryFromOverview({ overview });

  return buildStatusScanResult({
    cfg: overview.cfg,
    sourceConfig: overview.sourceConfig,
    secretDiagnostics: overview.secretDiagnostics,
    osSummary: overview.osSummary,
    tailscaleMode: overview.tailscaleMode,
    tailscaleDns: overview.tailscaleDns,
    tailscaleHttpsUrl: overview.tailscaleHttpsUrl,
    update: overview.update,
    gatewaySnapshot: overview.gatewaySnapshot,
    channelIssues: [],
    agentStatus: overview.agentStatus,
    channels: { rows: [], details: [] },
    summary,
    memory,
    memoryPlugin,
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
    resolveHasConfiguredChannels: (cfg) =>
      hasPotentialConfiguredChannels(cfg, process.env, {
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
