import { formatCliCommand } from "../cli/command-format.js";
import { isNixMode } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";

/** Settle managed service teardown before reset or uninstall may remove user data. */
export async function stopGatewayForCleanup(
  runtime: RuntimeEnv,
  operation: "reset" | "uninstall",
): Promise<boolean> {
  const uninstall = operation === "uninstall";
  if (isNixMode) {
    // Nix owns its service lifecycle. Reset skips it; explicit uninstall refuses it.
    if (uninstall) {
      runtime.error(
        `Nix mode detected; service uninstall is disabled. Manage the service through your Nix profile instead, then run ${formatCliCommand("openclaw status")} to verify.`,
      );
    }
    return !uninstall;
  }
  const reportFailure = (label: string, error: unknown, nextStep: string) => {
    runtime.error(
      uninstall
        ? `${label}: ${formatErrorMessage(error)}. Run ${formatCliCommand("openclaw gateway status --deep")} ${nextStep}.`
        : `${label}: ${String(error)}`,
    );
  };
  const service = resolveGatewayService();
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    reportFailure("Gateway service check failed", err, "for service diagnostics");
    return false;
  }
  let stopped = true;
  if (loaded) {
    try {
      await service.stop({ env: process.env, stdout: process.stdout });
    } catch (err) {
      stopped = false;
      reportFailure("Gateway stop failed", err, "before retrying uninstall");
    }
  } else if (uninstall) {
    runtime.log(`Gateway service ${service.notLoadedText}.`);
  }
  if (uninstall) {
    // Removing registration still prevents relaunch when stopping the process failed.
    try {
      await service.uninstall({ env: process.env, stdout: process.stdout });
    } catch (err) {
      reportFailure("Gateway uninstall failed", err, "for the service state");
      return false;
    }
  }
  return stopped;
}
