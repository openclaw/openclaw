import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../command-format.js";
import type { DaemonStatus } from "./status.gather.js";

/** True when the probe reported a loaded build id or the service layout an on-disk one. */
export function hasGatewayBuildIdentity(status: DaemonStatus): boolean {
  return Boolean(status.gateway?.buildId?.trim() || status.gateway?.installedBuildId?.trim());
}

/** A build that lands under a running Gateway leaves it serving an install it can no
 * longer fully load: already-imported chunks keep working while every dynamic import it
 * has not reached yet resolves against replaced files. Name that state here so it stops
 * surfacing later as unrelated-looking module errors. */
export function printGatewayBuildIdentity(
  status: DaemonStatus,
  out: {
    printInfo: (name: string, value: string) => void;
    printWarning: (message: string) => void;
  },
): void {
  const runningBuildId = status.gateway?.buildId?.trim();
  const installedBuildId = status.gateway?.installedBuildId?.trim();
  if (!runningBuildId && !installedBuildId) {
    return;
  }
  const onDisk =
    installedBuildId && installedBuildId !== runningBuildId ? `, on disk ${installedBuildId}` : "";
  out.printInfo("Gateway build:", terminalText`${runningBuildId ?? "unknown"}${onDisk}`);
  if (!status.gateway?.restartRequired) {
    return;
  }
  out.printWarning(
    terminalText`Restart required: the running Gateway loaded build ${runningBuildId ?? "unknown"}, but the installation on disk is build ${installedBuildId ?? "unknown"}. Imports it has not already loaded will fail until it restarts.`,
  );
  // The restart has to reach the same Gateway this status read, and profile selection
  // lives only in this process, so the printed command must carry it forward; pasting a
  // bare `openclaw gateway restart` into another shell would restart the default
  // profile's Gateway and leave this one stale.
  out.printWarning(`Restart it with: ${formatCliCommand("openclaw gateway restart")}`);
}
