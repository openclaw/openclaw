import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { defaultRuntime } from "../../runtime.js";
import { displayPath } from "../../utils.js";
import { formatCliCommand } from "../command-format.js";
import { resolveDaemonServiceInstallGuidance } from "./shared.js";
import type { DaemonStatus } from "./status.gather.js";

export type DaemonStatusVersionOutput = {
  printInfo: (name: string, value: string) => void;
  printWarning: (message: string) => void;
  infoText: (value: string) => string;
  spacer: () => void;
};

/** Prints the CLI / Gateway / service version lines and the loaded-vs-on-disk build identity. */
export function printDaemonStatusVersions(
  status: DaemonStatus,
  out: DaemonStatusVersionOutput,
): void {
  const gatewayVersion = status.rpc?.server?.version?.trim() || status.gateway?.version?.trim();
  const cliVersionLine = status.cli
    ? status.cli.entrypoint
      ? terminalText`${status.cli.version} (${displayPath(status.cli.entrypoint)})`
      : terminalText`${status.cli.version}`
    : null;
  // The installed service is readable without a Gateway handshake, so its facts stay
  // available for the failed-probe path below.
  const serviceInstallVersion = status.service.layout?.packageVersion?.trim();
  const serviceInstallLine = serviceInstallVersion
    ? status.service.layout?.packageRoot
      ? terminalText`${serviceInstallVersion} (${displayPath(status.service.layout.packageRoot)})`
      : terminalText`${serviceInstallVersion}`
    : null;
  if (gatewayVersion || serviceInstallLine || hasGatewayBuildIdentity(status)) {
    if (cliVersionLine) {
      out.printInfo("CLI version:", cliVersionLine);
    }
    if (gatewayVersion) {
      out.printInfo("Gateway version:", terminalText`${gatewayVersion}`);
      if (status.cli?.version && status.cli.version !== gatewayVersion) {
        out.printWarning(
          terminalText`Warning: this OpenClaw command is version ${status.cli.version}, but the running Gateway is version ${gatewayVersion}.`,
        );
        out.printWarning(
          "Check `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`; if this mismatch is unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
        );
      }
    } else if (serviceInstallLine) {
      // No Gateway version came back (failed or skipped probe). Report the install the
      // service points at so a stale service behind a bare connect error stays visible.
      out.printInfo("Gateway service version:", serviceInstallLine);
      defaultRuntime.log(out.infoText("The Gateway did not report its own version."));
      if (
        !status.service.installationDrift &&
        status.service.targetRole !== "diagnostic-only" &&
        status.cli?.version &&
        serviceInstallVersion &&
        status.cli.version !== serviceInstallVersion
      ) {
        out.printWarning(
          terminalText`Warning: this OpenClaw command is version ${status.cli.version}, but the installed Gateway service is version ${serviceInstallVersion}.`,
        );
        const guidance = resolveDaemonServiceInstallGuidance(status.service.targetRole);
        if (guidance) {
          out.printWarning(guidance);
        }
      }
    }
    printGatewayBuildIdentity(status, out);
    out.spacer();
  }
}

/** True when the probe reported a loaded build id or the service layout an on-disk one. */
function hasGatewayBuildIdentity(status: DaemonStatus): boolean {
  return Boolean(status.gateway?.buildId?.trim() || status.gateway?.installedBuildId?.trim());
}

/** A build that lands under a running Gateway leaves it serving an install it can no
 * longer fully load: already-imported chunks keep working while every dynamic import it
 * has not reached yet resolves against replaced files. Name that state here so it stops
 * surfacing later as unrelated-looking module errors. */
function printGatewayBuildIdentity(
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
