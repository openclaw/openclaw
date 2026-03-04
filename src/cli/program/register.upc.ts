/**
 * Register UPC CLI Commands.
 *
 * Provides CLI interface for configuring and managing the Private UPC system.
 * Commands:
 *   - openclaw upc set <credential>     Set or reset the UPC credential
 *   - openclaw upc reset                Clear the UPC verification state
 *   - openclaw upc status               Check UPC configuration and status
 *   - openclaw upc disable              Disable the UPC feature
 */

import type { Command } from "commander";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import { CONFIG_PATH } from "../../config/paths.js";
import { danger, info, success, warn } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "../gateway-rpc.js";

type UpcCommandOptions = GatewayRpcOpts & {
  duration?: string;
  timeWindowMinutes?: string;
};

export function registerUpcCommand(program: Command) {
  program
    .command("upc <action> [credential]")
    .description("Manage Private UPC (User Protocol Credential) security feature")
    .option(
      "--duration <mode>",
      "Verification cache duration: per-action, once-per-session, per-agent, time-window (default: once-per-session)",
    )
    .option("--time-window-minutes <minutes>", "Duration in minutes for time-window mode (1-1440)")
    .addHelpText(
      "after",
      () =>
        `
${theme.bold("Usage:")}
  openclaw upc set <credential>         Set or update the UPC credential
  openclaw upc reset                    Clear the verification state (keeps credential)
  openclaw upc status                   Show UPC configuration and current status
  openclaw upc disable                  Disable the UPC feature

${theme.bold("Examples:")}
  openclaw upc set mysecretcode
  openclaw upc status
  openclaw upc reset

${theme.muted("Docs:")} ${formatDocsLink("/cli/upc", "docs.openclaw.ai/cli/upc")}
`,
    )
    .action(async (action, credential, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const actionLower = (action ?? "").toLowerCase();

        switch (actionLower) {
          case "set":
            await handleUpcSet(credential, opts);
            break;
          case "reset":
            await handleUpcReset();
            break;
          case "status":
            await handleUpcStatus();
            break;
          case "disable":
            await handleUpcDisable();
            break;
          default:
            if (!credential) {
              info("No UPC action specified. Use 'openclaw upc --help' for usage.");
              return;
            }
            info(`Unknown UPC action: ${action}`);
        }
      });
    });
}

/**
 * Handle `openclaw upc set <credential>` - Set or update the UPC credential.
 */
async function handleUpcSet(credential: string | undefined, opts: UpcCommandOptions) {
  if (!credential || credential.trim().length === 0) {
    danger("Error: Credential is required.");
    danger("Usage: openclaw upc set <credential>");
    process.exit(1);
  }

  const trimmedCred = credential.trim();

  if (trimmedCred.length < 4) {
    danger("Error: Credential must be at least 4 characters long.");
    process.exit(1);
  }

  try {
    // Read current config
    const snapshot = readConfigFileSnapshot();

    // Call gateway when available so credential handling stays server-side.
    try {
      await callGatewayFromCli("upc.set", opts, { credential: trimmedCred }, { progress: false });
    } catch {
      // Ignore gateway reachability issues; we'll still persist config locally.
    }

    // Update config with UPC settings
    const updated = {
      ...snapshot.resolved,
      upc: {
        ...snapshot.resolved.upc,
        enabled: true,
        credential: trimmedCred,
        duration: opts.duration ?? snapshot.resolved.upc?.duration ?? "once-per-session",
        timeWindowMinutes: opts.timeWindowMinutes ?? snapshot.resolved.upc?.timeWindowMinutes,
      },
    };

    // Write updated config
    await writeConfigFile(updated, { baseHash: snapshot.hash });

    success("UPC credential set successfully.");
    info(`Feature enabled: ${updated.upc.enabled}`);
    info(`Duration mode: ${updated.upc.duration}`);
    if (updated.upc.duration === "time-window" && updated.upc.timeWindowMinutes) {
      info(`Time window: ${updated.upc.timeWindowMinutes} minutes`);
    }
    info(`Config saved to: ${shortenHomePath(CONFIG_PATH)}`);
  } catch (err) {
    danger(`Error setting UPC credential: ${String(err)}`);
    process.exit(1);
  }
}

/**
 * Handle `openclaw upc reset` - Clear the UPC verification state.
 * This clears any cached verifications but keeps the credential.
 */
async function handleUpcReset() {
  try {
    await callGatewayFromCli("upc.clear", {}, {}, { progress: false });
    success("UPC verification state reset.");
  } catch (err) {
    warn(`Could not reset UPC verification state through gateway: ${String(err)}`);
  }
}

/**
 * Handle `openclaw upc status` - Show UPC configuration and current status.
 */
async function handleUpcStatus() {
  try {
    const snapshot = readConfigFileSnapshot();
    const upc = snapshot.resolved.upc;

    if (!upc?.enabled) {
      info("UPC feature is disabled.");
      return;
    }

    success("UPC is enabled");
    info(`Duration mode: ${upc.duration ?? "once-per-session"}`);

    if (upc.duration === "time-window" && upc.timeWindowMinutes) {
      info(`Time window: ${upc.timeWindowMinutes} minutes`);
    }

    if (upc.riskTasks?.custom && upc.riskTasks.custom.length > 0) {
      info(`Custom risk tasks: ${upc.riskTasks.custom.join(", ")}`);
    }

    if (upc.requireUpcForChannels && upc.requireUpcForChannels.length > 0) {
      info(`Limited to channels: ${upc.requireUpcForChannels.join(", ")}`);
    }

    // Try to get live status from gateway.
    try {
      const status = (await callGatewayFromCli("upc.status", {}, {}, { progress: false })) as {
        enabled?: boolean;
        hasUPC?: boolean;
      };
      info(`Gateway enabled: ${status.enabled ? "yes" : "no"}`);
      info(`Gateway credential configured: ${status.hasUPC ? "yes" : "no"}`);
    } catch {
      warn("Could not retrieve gateway status (gateway might not be running)");
    }
  } catch (err) {
    danger(`Error reading UPC status: ${String(err)}`);
    process.exit(1);
  }
}

/**
 * Handle `openclaw upc disable` - Disable the UPC feature.
 * Keeps the credential stored in case it needs to be re-enabled.
 */
async function handleUpcDisable() {
  try {
    const snapshot = readConfigFileSnapshot();

    try {
      await callGatewayFromCli("upc.disable", {}, {}, { progress: false });
    } catch {
      // Keep local config in sync even when gateway is unavailable.
    }

    const updated = {
      ...snapshot.resolved,
      upc: {
        ...snapshot.resolved.upc,
        enabled: false,
      },
    };

    await writeConfigFile(updated, { baseHash: snapshot.hash });

    success("UPC feature disabled.");
    info("Credential is still stored. Use 'openclaw upc set' to re-enable.");
    info(`Config saved to: ${shortenHomePath(CONFIG_PATH)}`);
  } catch (err) {
    danger(`Error disabling UPC: ${String(err)}`);
    process.exit(1);
  }
}
