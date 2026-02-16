import type { Command } from "commander";
import {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "./runners.js";

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
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonStatus({
        rpc: cmdOpts,
        probe: Boolean(cmdOpts.probe),
        deep: Boolean(cmdOpts.deep),
        json: Boolean(cmdOpts.json),
      });
    });

  parent
    .command("install")
    .description("Install the Gateway service (launchd/systemd/schtasks)")
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--token <token>", "Gateway token (token auth)")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonInstall(cmdOpts);
    });

  parent
    .command("uninstall")
    .description("Uninstall the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonUninstall(cmdOpts);
    });

  parent
    .command("start")
    .description("Start the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonStart(cmdOpts);
    });

  parent
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonStop(cmdOpts);
    });

  parent
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      await runDaemonRestart(cmdOpts);
    });
}
