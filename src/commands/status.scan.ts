import { withProgress } from "../cli/progress.js";
import { hasConfiguredChannelsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import { buildPluginCompatibilitySnapshotNotices } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import { resolveStatusMemoryStatusSnapshot } from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";
import { scanStatusJsonWithPolicy } from "./status.scan.fast-json.js";

/**
 * Runs the status scan entrypoint, choosing the fast JSON policy path or the
 * interactive text scan path from CLI options.
 */
export async function scanStatus(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    all?: boolean;
    deep?: boolean;
  },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  if (opts.json) {
    // JSON status uses a policy wrapper so read-only fallback decisions stay
    // consistent between fast JSON and the richer text scan.
    return await scanStatusJsonWithPolicy(
      {
        timeoutMs: opts.timeoutMs,
        all: opts.all,
      },
      _runtime,
      {
        commandName: "status --json",
        resolveHasConfiguredChannels: (cfg, sourceConfig) =>
          hasConfiguredChannelsForReadOnlyScope({
            config: cfg,
            activationSourceConfig: sourceConfig,
          }),
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
      total: 10,
      enabled: true,
    },
    async (progress) => {
      const isFullScan = opts.all === true || opts.deep === true;
      const overview = await collectStatusScanOverview({
        commandName: "status",
        opts,
        showSecrets: process.env.OPENCLAW_SHOW_SECRETS?.trim() !== "0",
        includeLiveChannelStatus: isFullScan,
        includeChannelSetupRuntimeFallback: isFullScan,
        // Default status avoids secret reads and live channel fallback; deep/all
        // status opts into those slower probes for richer diagnostics.
        channelCredentialResolutionSkipped: !isFullScan,
        includeChannelSecretTargets: isFullScan ? undefined : false,
        fetchGitUpdate: isFullScan,
        includeRegistryUpdate: isFullScan,
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

      progress.setLabel("Checking plugins…");
      const pluginCompatibility = opts.all
        ? buildPluginCompatibilitySnapshotNotices({ config: overview.cfg })
        : [];
      progress.tick();

      progress.setLabel("Checking memory and sessions…");
      const result = await executeStatusScanFromOverview({
        overview,
        resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
          opts.all
            ? await resolveStatusMemoryStatusSnapshot({
                cfg,
                agentStatus,
                memoryPlugin,
              })
            : null,
        channelIssues: overview.channelIssues,
        channels: overview.channels,
        pluginCompatibility,
      });
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

      return result;
    },
  );
}
