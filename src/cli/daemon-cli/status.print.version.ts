import { defaultRuntime } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { resolveDaemonServiceInstallGuidance, type createCliStatusTextStyles } from "./shared.js";
import type { DaemonStatus } from "./status.gather.js";

function formatCliVersionLine(cli: DaemonStatus["cli"]): string | null {
  if (!cli) {
    return null;
  }
  return cli.entrypoint ? `${cli.version} (${shortenHomePath(cli.entrypoint)})` : cli.version;
}

/** A build that lands under a running Gateway leaves it serving an install it can no
 * longer fully load: already-imported chunks keep working while every dynamic import it
 * has not reached yet resolves against replaced files. Name that state here so it stops
 * surfacing later as unrelated-looking module errors. */
function printGatewayBuildIdentity(
  status: DaemonStatus,
  {
    label,
    infoText,
    warnText,
  }: Pick<ReturnType<typeof createCliStatusTextStyles>, "label" | "infoText" | "warnText">,
) {
  const runningBuildId = status.gateway?.buildId?.trim();
  const installedBuildId = status.gateway?.installedBuildId?.trim();
  if (!runningBuildId && !installedBuildId) {
    return;
  }
  const onDisk =
    installedBuildId && installedBuildId !== runningBuildId ? `, on disk ${installedBuildId}` : "";
  defaultRuntime.log(
    `${label("Gateway build:")} ${infoText(`${runningBuildId ?? "unknown"}${onDisk}`)}`,
  );
  if (!status.gateway?.restartRequired) {
    return;
  }
  defaultRuntime.error(
    warnText(
      `Restart required: the running Gateway loaded build ${runningBuildId}, but the installation on disk is build ${installedBuildId}. Imports it has not already loaded will fail until it restarts.`,
    ),
  );
  defaultRuntime.error(warnText("Restart it with: openclaw gateway restart"));
}

export function printDaemonStatusVersions(
  status: DaemonStatus,
  {
    label,
    infoText,
    warnText,
  }: Pick<ReturnType<typeof createCliStatusTextStyles>, "label" | "infoText" | "warnText">,
) {
  const gatewayVersion = status.rpc?.server?.version?.trim() || status.gateway?.version?.trim();
  const cliVersionLine = formatCliVersionLine(status.cli);
  // The installed service is readable without a Gateway handshake, so its facts stay
  // available for the failed-probe path below.
  const serviceInstallVersion = status.service.layout?.packageVersion?.trim();
  const serviceInstallLine = serviceInstallVersion
    ? status.service.layout?.packageRoot
      ? `${serviceInstallVersion} (${shortenHomePath(status.service.layout.packageRoot)})`
      : serviceInstallVersion
    : null;
  const hasBuildIdentity = Boolean(status.gateway?.buildId || status.gateway?.installedBuildId);
  if (!gatewayVersion && !serviceInstallLine && !hasBuildIdentity) {
    return;
  }
  if (cliVersionLine) {
    defaultRuntime.log(`${label("CLI version:")} ${infoText(cliVersionLine)}`);
  }
  if (gatewayVersion) {
    defaultRuntime.log(`${label("Gateway version:")} ${infoText(gatewayVersion)}`);
    if (status.cli?.version && status.cli.version !== gatewayVersion) {
      defaultRuntime.error(
        warnText(
          `Warning: this OpenClaw command is version ${status.cli.version}, but the running Gateway is version ${gatewayVersion}.`,
        ),
      );
      defaultRuntime.error(
        warnText(
          "Check `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`; if this mismatch is unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
        ),
      );
    }
  } else if (serviceInstallLine) {
    // No Gateway version came back (failed or skipped probe). Report the install the
    // service points at so a stale service behind a bare connect error stays visible.
    defaultRuntime.log(`${label("Gateway service version:")} ${infoText(serviceInstallLine)}`);
    defaultRuntime.log(infoText("The Gateway did not report its own version."));
    if (
      status.service.targetRole !== "diagnostic-only" &&
      status.cli?.version &&
      serviceInstallVersion &&
      status.cli.version !== serviceInstallVersion
    ) {
      defaultRuntime.error(
        warnText(
          `Warning: this OpenClaw command is version ${status.cli.version}, but the installed Gateway service is version ${serviceInstallVersion}.`,
        ),
      );
      const guidance = resolveDaemonServiceInstallGuidance(status.service.targetRole);
      if (guidance) {
        defaultRuntime.error(warnText(guidance));
      }
    }
  }
  printGatewayBuildIdentity(status, { label, infoText, warnText });
  defaultRuntime.log("");
}
