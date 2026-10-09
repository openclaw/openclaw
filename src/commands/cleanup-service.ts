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
  const service = resolveGatewayService();
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    runtime.error(
      uninstall
        ? `Gateway service check failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for service diagnostics.`
        : `Gateway service check failed: ${String(err)}`,
    );
    return false;
  }
  let stopped = true;
  if (loaded) {
    try {
      await service.stop({ env: process.env, stdout: process.stdout });
    } catch (err) {
      stopped = false;
      runtime.error(
        uninstall
          ? `Gateway stop failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} before retrying uninstall.`
          : `Gateway stop failed: ${String(err)}`,
      );
    }
  } else if (uninstall) {
    runtime.log(`Gateway service ${service.notLoadedText}.`);
  }
  if (uninstall) {
    // Removing registration still prevents relaunch when stopping the process failed.
    try {
      await service.uninstall({ env: process.env, stdout: process.stdout });
    } catch (err) {
      runtime.error(
        `Gateway uninstall failed: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for the service state.`,
      );
      return false;
    }
  }
  return stopped;
}
