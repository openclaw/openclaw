import type { Command } from "commander";
import { addJsonOption, addTimeoutOption } from "../option-builders.js";
import {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "./runners.js";

export function addGatewayServiceCommands(parent: Command, opts?: { statusDescription?: string }) {
  const status = addTimeoutOption(
    addJsonOption(
      parent
        .command("status")
        .description(opts?.statusDescription ?? "Show gateway service status + probe the Gateway")
        .option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)")
        .option("--token <token>", "Gateway token (if required)")
        .option("--password <password>", "Gateway password (password auth)")
        .option("--no-probe", "Skip RPC probe")
        .option("--deep", "Scan system-level services", false),
    ),
    { description: "Timeout in ms", defaultValue: "10000" },
  );

  status.action(async (cmdOpts) => {
    await runDaemonStatus({
      rpc: cmdOpts,
      probe: Boolean(cmdOpts.probe),
      deep: Boolean(cmdOpts.deep),
      json: Boolean(cmdOpts.json),
    });
  });

  addJsonOption(
    parent
      .command("install")
      .description("Install the Gateway service (launchd/systemd/schtasks)")
      .option("--port <port>", "Gateway port")
      .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
      .option("--token <token>", "Gateway token (token auth)")
      .option("--force", "Reinstall/overwrite if already installed", false),
  ).action(async (cmdOpts) => {
    await runDaemonInstall(cmdOpts);
  });

  addJsonOption(
    parent
      .command("uninstall")
      .description("Uninstall the Gateway service (launchd/systemd/schtasks)"),
  ).action(async (cmdOpts) => {
    await runDaemonUninstall(cmdOpts);
  });

  addJsonOption(
    parent.command("start").description("Start the Gateway service (launchd/systemd/schtasks)"),
  ).action(async (cmdOpts) => {
    await runDaemonStart(cmdOpts);
  });

  addJsonOption(
    parent.command("stop").description("Stop the Gateway service (launchd/systemd/schtasks)"),
  ).action(async (cmdOpts) => {
    await runDaemonStop(cmdOpts);
  });

  addJsonOption(
    parent.command("restart").description("Restart the Gateway service (launchd/systemd/schtasks)"),
  ).action(async (cmdOpts) => {
    await runDaemonRestart(cmdOpts);
  });
}
