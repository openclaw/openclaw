import type { Command } from "commander";
import { inheritOptionFromParent } from "../command-options.js";
import type { DaemonInstallOptions, GatewayRpcOpts } from "./types.js";

let daemonRunnersModulePromise: Promise<typeof import("./runners.js")> | undefined;

function loadDaemonRunnersModule() {
  daemonRunnersModulePromise ??= import("./runners.js");
  return daemonRunnersModulePromise;
}

function resolveInstallOptions(
  cmdOpts: DaemonInstallOptions,
  command?: Command,
): DaemonInstallOptions {
  const parentForce = inheritOptionFromParent<boolean>(command, "force");
  const parentPort = inheritOptionFromParent<string>(command, "port");
  const parentToken = inheritOptionFromParent<string>(command, "token");
  return {
    ...cmdOpts,
    force: Boolean(cmdOpts.force || parentForce),
    port: cmdOpts.port ?? parentPort,
    token: cmdOpts.token ?? parentToken,
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
    .option("--require-rpc", "Exit non-zero when the RPC probe fails", false)
    .option("--deep", "Scan system-level services", false)
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts, command) => {
      const { runDaemonStatus } = await loadDaemonRunnersModule();
      await runDaemonStatus({
        rpc: resolveRpcOptions(cmdOpts, command),
        probe: Boolean(cmdOpts.probe),
        requireRpc: Boolean(cmdOpts.requireRpc),
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
    .action(async (cmdOpts, command) => {
      const { runDaemonInstall } = await loadDaemonRunnersModule();
      await runDaemonInstall(resolveInstallOptions(cmdOpts, command));
    });

  parent
    .command("uninstall")
    .description("Uninstall the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      const { runDaemonUninstall } = await loadDaemonRunnersModule();
      await runDaemonUninstall(cmdOpts);
    });

  parent
    .command("start")
    .description("Start the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      const { runDaemonStart } = await loadDaemonRunnersModule();
      await runDaemonStart(cmdOpts);
    });

  parent
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      const { runDaemonStop } = await loadDaemonRunnersModule();
      await runDaemonStop(cmdOpts);
    });

  parent
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (cmdOpts) => {
      const { runDaemonRestart } = await loadDaemonRunnersModule();
      await runDaemonRestart(cmdOpts);
    });
}
