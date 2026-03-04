import type { Command } from "commander";
import { inheritOptionFromParent } from "../command-options.js";
import {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "./runners.js";
import type { DaemonInstallOptions, GatewayRpcOpts } from "./types.js";

function resolveInstallOptions(
  cmdOpts: DaemonInstallOptions,
  command?: Command,
): DaemonInstallOptions {
  const parentForce = inheritOptionFromParent<boolean>(command, "force");
  const parentPort = inheritOptionFromParent<string>(command, "port");
  const parentToken = inheritOptionFromParent<string>(command, "token");
  const parentSystem = inheritOptionFromParent<boolean>(command, "system");
  return {
    ...cmdOpts,
    force: Boolean(cmdOpts.force || parentForce),
    port: cmdOpts.port ?? parentPort,
    token: cmdOpts.token ?? parentToken,
    system: Boolean(cmdOpts.system || parentSystem),
  };
}

function resolveLifecycleOptions(
  cmdOpts: DaemonInstallOptions | GatewayRpcOpts,
  command?: Command,
): { json?: boolean; system?: boolean } {
  const parentSystem = inheritOptionFromParent<boolean>(command, "system");
  return {
    json: Boolean(cmdOpts.json),
    system: Boolean(("system" in cmdOpts ? cmdOpts.system : false) || parentSystem),
  };
}

function resolveRpcOptions(cmdOpts: GatewayRpcOpts, command?: Command): GatewayRpcOpts {
  const parentToken = inheritOptionFromParent<string>(command, "token");
  const parentPassword = inheritOptionFromParent<string>(command, "password");
  return {
    ...cmdOpts,
    token: cmdOpts.token ?? parentToken,
    password: cmdOpts.password ?? parentPassword,
  };
}

export function addGatewayServiceCommands(parent: Command, opts?: { statusDescription?: string }) {
  parent
    .command("status")
    .description(opts?.statusDescription ?? "Show gateway service status + probe the Gateway")
    .option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--no-probe", "Skip RPC probe")
    .option("--deep", "Scan system-level services", false)
    .option("--system", "Use Linux system-level systemd scope", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runDaemonStatus({
        rpc: resolveRpcOptions(cmdOpts, command),
        probe: Boolean(cmdOpts.probe),
        deep: Boolean(cmdOpts.deep),
        json: Boolean(cmdOpts.json),
        system: Boolean(cmdOpts.system),
      });
    });

  parent
    .command("install")
    .description("Install the Gateway service (launchd/systemd/schtasks)")
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--token <token>", "Gateway token (token auth)")
    .option("--system", "Use Linux system-level systemd scope", false)
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runDaemonInstall(resolveInstallOptions(cmdOpts, command));
    });

  parent
    .command("uninstall")
    .description("Uninstall the Gateway service (launchd/systemd/schtasks)")
    .option("--system", "Use Linux system-level systemd scope", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runDaemonUninstall(resolveLifecycleOptions(cmdOpts, command));
    });

  parent
    .command("start")
    .description("Start the Gateway service (launchd/systemd/schtasks)")
    .option("--system", "Use Linux system-level systemd scope", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runDaemonStart(resolveLifecycleOptions(cmdOpts, command));
    });

  parent
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .option("--system", "Use Linux system-level systemd scope", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runDaemonStop(resolveLifecycleOptions(cmdOpts, command));
    });

  parent
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .option("--system", "Use Linux system-level systemd scope", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      await runDaemonRestart(resolveLifecycleOptions(cmdOpts, command));
    });
}
