import { formatErrorMessage } from "../../infra/errors.js";
import { formatCliCommand } from "../command-format.js";

// Inspects the local systemd gateway installation for a dueling (user + system)
// scope and warns when both units exist. A failed inspection is logged rather
// than swallowed so the operator-visible diagnosis is not silently dropped.
export async function inspectSystemdGatewayDuelingScope(opts: {
  processEnv: NodeJS.ProcessEnv;
  port: number;
  gatewayLog: { warn: (message: string) => void };
}): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  const { findSystemdGatewayInstallation, formatDuelingScopesWarning } =
    await import("../../daemon/systemd.js");
  try {
    const installation = await findSystemdGatewayInstallation(opts.processEnv);
    const warning = installation ? formatDuelingScopesWarning(installation, opts.port) : null;
    if (warning) {
      opts.gatewayLog.warn(`service-mode: ${warning}`);
    }
  } catch (error: unknown) {
    // Keep the log line single-line and single-period: manager errors arrive as
    // multi-line messages that often already end their own sentence.
    const reason = formatErrorMessage(error).replaceAll(/\s+/gu, " ").trim();
    const detail = reason.endsWith(".") ? reason : `${reason}.`;
    opts.gatewayLog.warn(
      `service-mode: could not inspect the systemd gateway installation: ${detail} The dueling-scope diagnosis was NOT checked; check read access to the reported unit and run ${formatCliCommand("openclaw doctor")} for the full check.`,
    );
  }
}
