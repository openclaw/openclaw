import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { withProgress } from "../cli/progress.js";
import { buildPluginCompatibilityNotices } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveStatusMemoryStatusSnapshot } from "./status.scan-memory.ts";
import {
  collectStatusScanOverview,
  resolveStatusSummaryFromOverview,
} from "./status.scan-overview.ts";
import { buildStatusScanResult, type StatusScanResult } from "./status.scan-result.ts";
import { scanStatusJsonWithPolicy } from "./status.scan.fast-json.js";
import { resolveMemoryPluginStatus } from "./status.scan.shared.js";

export async function scanStatus(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  if (opts.json) {
    return await scanStatusJsonWithPolicy(
      {
        timeoutMs: opts.timeoutMs,
        all: opts.all,
      },
      _runtime,
      {
        commandName: "status --json",
        resolveHasConfiguredChannels: (cfg) => hasPotentialConfiguredChannels(cfg),
        resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
          await resolveStatusMemoryStatusSnapshot({
            cfg,
            agentStatus,
            memoryPlugin,
          }),
      },
    );
  }
  return await withProgress(
    {
      label: "Scanning status…",
      total: 11,
      enabled: true,
    },
    async (progress) => {
      const overview = await collectStatusScanOverview({
        commandName: "status",
        opts,
        showSecrets: process.env.OPENCLAW_SHOW_SECRETS?.trim() !== "0",
        progress,
        labels: {
          loadingConfig: "Loading config…",
          checkingTailscale: "Checking Tailscale…",
          checkingForUpdates: "Checking for updates…",
          resolvingAgents: "Resolving agents…",
          probingGateway: "Probing gateway…",
          queryingChannelStatus: "Querying channel status…",
          summarizingChannels: "Summarizing channels…",
        },
      });

      progress.setLabel("Checking memory…");
      const memoryPlugin = resolveMemoryPluginStatus(overview.cfg);
      const memory = await resolveStatusMemoryStatusSnapshot({
        cfg: overview.cfg,
        agentStatus: overview.agentStatus,
        memoryPlugin,
      });
      progress.tick();

      progress.setLabel("Checking plugins…");
      const pluginCompatibility = buildPluginCompatibilityNotices({ config: overview.cfg });
      progress.tick();

      progress.setLabel("Reading sessions…");
      const summary = await resolveStatusSummaryFromOverview({ overview });
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

      return buildStatusScanResult({
        cfg: overview.cfg,
        sourceConfig: overview.sourceConfig,
        secretDiagnostics: overview.secretDiagnostics,
        osSummary: overview.osSummary,
        tailscaleMode: overview.tailscaleMode,
        tailscaleDns: overview.tailscaleDns,
        tailscaleHttpsUrl: overview.tailscaleHttpsUrl,
        update: overview.update,
        gatewaySnapshot: {
          gatewayConnection: overview.gatewaySnapshot.gatewayConnection,
          remoteUrlMissing: overview.gatewaySnapshot.remoteUrlMissing,
          gatewayMode: overview.gatewaySnapshot.gatewayMode,
          gatewayProbeAuth: overview.gatewaySnapshot.gatewayProbeAuth,
          gatewayProbeAuthWarning: overview.gatewaySnapshot.gatewayProbeAuthWarning,
          gatewayProbe: overview.gatewaySnapshot.gatewayProbe,
          gatewayReachable: overview.gatewaySnapshot.gatewayReachable,
          gatewaySelf: overview.gatewaySnapshot.gatewaySelf,
        },
        channelIssues: overview.channelIssues,
        agentStatus: overview.agentStatus,
        channels: overview.channels,
        summary,
        memory,
        memoryPlugin,
        pluginCompatibility,
      });
    },
  );
}
