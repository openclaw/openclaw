import { withProgress } from "../cli/progress.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildStatusAllReportData } from "./status-all/report-data.js";
import { buildStatusAllReportLines } from "./status-all/report-lines.js";
import { resolveStatusServiceSummaries } from "./status-runtime-shared.ts";
import { resolveNodeOnlyGatewayInfo } from "./status.node-mode.js";
import { collectStatusScanOverview } from "./status.scan-overview.ts";

export async function statusAllCommand(
  runtime: RuntimeEnv,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await withProgress({ label: "Scanning status --all…", total: 11 }, async (progress) => {
    const overview = await collectStatusScanOverview({
      commandName: "status --all",
      opts: {
        timeoutMs: opts?.timeoutMs,
      },
      showSecrets: false,
      runtime,
      useGatewayCallOverridesForChannelsStatus: true,
      progress,
      labels: {
        loadingConfig: "Loading config…",
        checkingTailscale: "Checking Tailscale…",
        checkingForUpdates: "Checking for updates…",
        resolvingAgents: "Scanning agents…",
        probingGateway: "Probing gateway…",
        queryingChannelStatus: "Querying gateway…",
        summarizingChannels: "Summarizing channels…",
      },
    });
    progress.setLabel("Checking services…");
    const [daemon, nodeService] = await resolveStatusServiceSummaries();
    const nodeOnlyGateway = await resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeService,
    });
    progress.tick();
    const lines = await buildStatusAllReportLines({
      progress,
      ...(await buildStatusAllReportData({
        overview,
        daemon,
        nodeService,
        nodeOnlyGateway,
        progress,
        timeoutMs: opts?.timeoutMs,
      })),
    });

    progress.setLabel("Rendering…");
    runtime.log(lines.join("\n"));
    progress.tick();
  });
}
