import { defaultRuntime } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import type { createCliStatusTextStyles } from "./shared.js";
import type { DaemonStatus } from "./status.gather.js";

function formatCliVersionLine(cli: DaemonStatus["cli"]): string | null {
  if (!cli) {
    return null;
  }
  return cli.entrypoint ? `${cli.version} (${shortenHomePath(cli.entrypoint)})` : cli.version;
}

export function printDaemonStatusVersions(
  status: DaemonStatus,
  {
    label,
    infoText,
    warnText,
  }: Pick<ReturnType<typeof createCliStatusTextStyles>, "label" | "infoText" | "warnText">,
  reinstallGuidance: string,
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
  if (gatewayVersion) {
    if (cliVersionLine) {
      defaultRuntime.log(`${label("CLI version:")} ${infoText(cliVersionLine)}`);
    }
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
    defaultRuntime.log("");
  } else if (serviceInstallLine) {
    // No Gateway version came back (failed or skipped probe). Report the install the
    // service points at so a stale service behind a bare connect error stays visible.
    if (cliVersionLine) {
      defaultRuntime.log(`${label("CLI version:")} ${infoText(cliVersionLine)}`);
    }
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
      defaultRuntime.error(warnText(reinstallGuidance));
    }
    defaultRuntime.log("");
  }
}
