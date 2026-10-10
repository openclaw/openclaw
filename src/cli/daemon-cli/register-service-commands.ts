// Gateway service command registration shared by `gateway` and legacy `daemon` CLIs.
import { Option, type Command } from "commander";
import { isGatewayServiceEnv } from "../../daemon/constants.js";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { inheritOptionFromParent } from "../command-options.js";
import { resolveGatewayRpcOptionsWithLocalPort } from "../gateway-rpc.js";
import type { DaemonInstallOptions, DaemonLifecycleOptions } from "./types.js";

function updateExecutorOption(): Option {
  return new Option("--update-executor <mode>", "Private update executor")
    .choices(["check", "run"])
    .hideHelp();
}

async function runUpdateCommand(
  mode: string | undefined,
  action: "install" | "stop" | "restart",
  operation: () => Promise<void>,
): Promise<void> {
  if (mode === undefined) {
    await operation();
    return;
  }
  const { runGatewayServiceUpdateCommand } = await import("./update-executor.js");
  await runGatewayServiceUpdateCommand(mode, action, operation);
}

function resolveJsonOption(cmdOpts: { json?: boolean }, command?: Command): boolean {
  const parentJson = inheritOptionFromParent<boolean>(command, "json", "cli");
  return Boolean(cmdOpts.json || parentJson);
}

function resolveInstallOptions(
  cmdOpts: DaemonInstallOptions,
  command?: Command,
): DaemonInstallOptions {
  const parentForce = inheritOptionFromParent<boolean>(command, "force");
  const parentPort = inheritOptionFromParent<string>(command, "port");
  const parentToken = inheritOptionFromParent<string>(command, "token");
  const parentAllowUnconfigured = inheritOptionFromParent<boolean>(command, "allowUnconfigured");
  return {
    ...cmdOpts,
    force: Boolean(cmdOpts.force || parentForce),
    port: cmdOpts.port ?? parentPort,
    token: cmdOpts.token ?? parentToken,
    allowUnconfigured: cmdOpts.allowUnconfigured ?? parentAllowUnconfigured,
    json: resolveJsonOption(cmdOpts, command),
  };
}

function resolveRestartOptions(cmdOpts: DaemonLifecycleOptions, command?: Command) {
  const options = resolveLifecycleOptions(cmdOpts, command);
  const safeFromGateway =
    process.platform === "win32" &&
    isGatewayServiceEnv(process.env) &&
    !isGatewayExternallySupervised() &&
    !options.force &&
    cmdOpts.wait === undefined &&
    !cmdOpts.preserveDefinition &&
    !cmdOpts.skipDeferral;
  return {
    ...options,
    safe: cmdOpts.safe || safeFromGateway,
  };
}

function resolveLifecycleOptions(cmdOpts: DaemonLifecycleOptions, command?: Command) {
  const parentForce = inheritOptionFromParent<boolean>(command, "force");
  return {
    ...cmdOpts,
    force: Boolean(cmdOpts.force || parentForce),
    json: resolveJsonOption(cmdOpts, command),
  };
}

/** Attach Gateway service status/install/lifecycle subcommands to a parent command. */
export function addGatewayServiceCommands(parent: Command, opts?: { statusDescription?: string }) {
  parent
    .command("status")
    .description(
      opts?.statusDescription ?? "Show gateway service status + check connectivity/capability",
    )
    .option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)")
    .option("--port <port>", "Local Gateway port")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--no-probe", "Skip RPC check")
    .option("--require-rpc", "Exit non-zero when the RPC check fails", false)
    .option("--deep", "Scan system-level services", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      const { runDaemonStatus } = await import("./status.runtime.js");
      await runDaemonStatus({
        rpc: resolveGatewayRpcOptionsWithLocalPort(
          {
            ...cmdOpts,
            timeout:
              command.getOptionValueSource("timeout") === "default" ? undefined : cmdOpts.timeout,
          },
          command,
        ),
        probe: Boolean(cmdOpts.probe),
        requireRpc: Boolean(cmdOpts.requireRpc),
        deep: Boolean(cmdOpts.deep),
        json: resolveJsonOption(cmdOpts, command),
      });
    });

  parent
    .command("install")
    .description("Install and start the Gateway service (launchd/systemd/schtasks)")
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--runtime-path <path>", "Pin an absolute Node/Bun executable path")
    .addOption(
      new Option("--expected-runtime-pin <json>", "Require the observed runtime intent").hideHelp(),
    )
    .addOption(
      new Option(
        "--restore-service-cli <json>",
        "Restore the service onto a retained OpenClaw CLI",
      ).hideHelp(),
    )
    .option("--token <token>", "Gateway token (token auth)")
    .option("--wrapper <path>", "Executable wrapper for generated service ProgramArguments")
    .option("--allow-unconfigured", "Allow the service to start without gateway.mode=local")
    .option("--force", "Reinstall if already installed (may restart a running Gateway)", false)
    .option("--json", "Output JSON", false)
    .addOption(updateExecutorOption())
    .action(async (cmdOpts, command) => {
      await runUpdateCommand(cmdOpts.updateExecutor, "install", async () => {
        const { runDaemonInstall } = await import("./install.runtime.js");
        await runDaemonInstall(resolveInstallOptions(cmdOpts, command));
      });
    });

  for (const [name, description, action] of [
    ["uninstall", "Uninstall", "runDaemonUninstall"],
    ["start", "Start", "runDaemonStart"],
  ] as const) {
    parent
      .command(name)
      .description(`${description} the Gateway service (launchd/systemd/schtasks)`)
      .option("--json", "Output JSON", false)
      .action(async (cmdOpts, command) => {
        const lifecycle = await import("./lifecycle.runtime.js");
        await lifecycle[action]({ ...cmdOpts, json: resolveJsonOption(cmdOpts, command) });
      });
  }

  parent
    .command("stop")
    .addOption(updateExecutorOption())
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .option("--force", "Allow stop from a non-interactive shell", false)
    .option("--json", "Output JSON", false)
    .option(
      "--disable",
      "Persistently suppress KeepAlive/RunAtLoad so the gateway does not respawn until next start (launchd only)",
      false,
    )
    .action(async (cmdOpts, command) => {
      await runUpdateCommand(cmdOpts.updateExecutor, "stop", async () => {
        const { runDaemonStop } = await import("./lifecycle.runtime.js");
        await runDaemonStop(resolveLifecycleOptions(cmdOpts, command));
      });
    });

  parent
    .command("restart")
    .addOption(updateExecutorOption())
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .option("--preserve-definition", "Keep the native service definition", false)
    .option("--force", "Begin restart now; drain admitted work within the shutdown budget", false)
    .option(
      "--safe",
      "Request an OpenClaw-aware restart after active work drains " +
        "(bounded wait; may force after the timeout expires)",
      false,
    )
    .option(
      "--skip-deferral",
      "Bypass the safe-restart active-work deferral gate; close-stage reply drain still applies; requires --safe",
      false,
    )
    .option(
      "--wait <duration>",
      "Wait duration before restart (ms, 10s, 5m; 0 waits indefinitely). " +
        "For non-safe restarts (plain restart); not compatible with --force or --safe",
    )
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runUpdateCommand(cmdOpts.updateExecutor, "restart", async () => {
        const { runDaemonRestart } = await import("./lifecycle.runtime.js");
        await runDaemonRestart(resolveRestartOptions(cmdOpts, command));
      });
    });
}
