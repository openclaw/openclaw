// Gateway run command option registration and lazy handoff to runtime startup.
import { Option, type Command } from "commander";
import type { StartupConfigPreflightOptions } from "../../commands/startup-config-preflight.js";
import {
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "../../daemon/windows-task-supervisor-contract.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { resolveCliStartupPolicy } from "../command-startup-policy.js";
import type { createGatewayDispatchStartupTrace } from "../startup-trace.js";
import type { GatewayRunOpts } from "./run-options.js";
import { resolveGatewayRunOptions } from "./run-options.js";
import { getGatewayRunRuntimeHooks } from "./runtime-hooks.js";

type GatewayRunCommandHooks = {
  beforeRun?: (opts: Pick<GatewayRunOpts, "force" | "reset">) => Promise<void> | void;
};

export async function bootstrapGatewayRun(params: {
  opts: Pick<GatewayRunOpts, "force" | "reset">;
  runtime: RuntimeEnv;
  commandPath: string[];
  startupPolicy: ReturnType<typeof resolveCliStartupPolicy>;
  startupTrace: ReturnType<typeof createGatewayDispatchStartupTrace>;
}): Promise<void> {
  const { opts, runtime, commandPath, startupPolicy, startupTrace } = params;
  let beforeStatePreparation: StartupConfigPreflightOptions["beforeStatePreparation"];
  const shouldBootstrap = await startupTrace.measure("gateway-run-pre-bootstrap", async () => {
    const { prepareGatewayRunBootstrap, recheckGatewayRunBootstrap } =
      await import("./pre-bootstrap.js");
    const prepared = await prepareGatewayRunBootstrap({ opts, runtime });
    if (prepared) {
      beforeStatePreparation = (snapshot) =>
        recheckGatewayRunBootstrap({ opts, runtime, ...(snapshot ? { snapshot } : {}) });
    }
    return prepared;
  });
  if (!shouldBootstrap) {
    return;
  }
  await startupTrace.measure("gateway-run-bootstrap", async () => {
    const { ensureCliExecutionBootstrap } = await import("../command-execution-startup.js");
    await ensureCliExecutionBootstrap({
      runtime,
      commandPath,
      startupPolicy,
      loadPlugins: false,
      ...(beforeStatePreparation ? { beforeStatePreparation } : {}),
    });
    const { reloadTrustedGatewayRunEnvironment } = await import("./pre-bootstrap.js");
    await startupTrace.measure("gateway-run-reload-environment", () =>
      reloadTrustedGatewayRunEnvironment({ runtime }),
    );
  });
}

export function addGatewayRunCommand(cmd: Command, hooks: GatewayRunCommandHooks = {}): Command {
  return cmd
    .option("--port <port>", "Port for the gateway WebSocket")
    .option(
      "--published-port <port>",
      "Mapped host port for container browser origins (launch only)",
    )
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"lan"|"tailnet"|"auto"|"custom"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: OPENCLAW_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", 'Gateway auth mode ("none"|"token"|"password"|"trusted-proxy")')
    .option("--password <password>", "Password for auth mode=password")
    .option("--password-file <path>", "Read gateway password from file")
    .option("--tailscale <mode>", 'Tailscale exposure mode ("off"|"serve"|"funnel")')
    .addOption(new Option("--tailscale-reset-on-exit").hideHelp())
    .option(
      "--allow-unconfigured",
      "Allow gateway start without enforcing gateway.mode=local in config (does not repair config)",
      false,
    )
    .option("--dev", "Create a dev config + workspace if missing (no BOOTSTRAP.md)", false)
    .option(
      "--ambient-channels",
      "Allow the gateway to auto-configure channels from ambient environment variables",
      false,
    )
    .option("--dev-ambient-channels", "Deprecated alias for --ambient-channels", false)
    .option(
      "--reset",
      "Reset dev config + credentials + sessions + workspace (requires --dev)",
      false,
    )
    .addOption(new Option(WINDOWS_TASK_SUPERVISOR_FLAG).hideHelp())
    .addOption(new Option(`${WINDOWS_TASK_SUPERVISOR_CHILD_FLAG} <restart-code>`).hideHelp())
    .addOption(new Option("--update-canary").hideHelp())
    .option("--force", "Kill any existing listener on the target port before starting", false)
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--cli-backend-logs",
      "Only show CLI backend logs in the console (includes stdout/stderr)",
      false,
    )
    .option("--claude-cli-logs", "Deprecated alias for --cli-backend-logs", false)
    .option("--ws-log <style>", 'WebSocket log style ("auto"|"full"|"compact")', "auto")
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .option("--raw-stream", "Log raw model stream events to jsonl", false)
    .option("--raw-stream-path <path>", "Raw stream jsonl path")
    .action(async (opts, command) => {
      const resolved = resolveGatewayRunOptions(opts, command);
      const { withAgentDatabaseStartupAdmission } =
        await import("../../state/agent-database-startup.js");
      return withAgentDatabaseStartupAdmission(
        async () => {
          try {
            await hooks.beforeRun?.(resolved);
            const { runGatewayCommand } = await import("./run.js");
            await runGatewayCommand(resolved, getGatewayRunRuntimeHooks());
          } catch (error) {
            const { handleGatewayStartupMaintenance } = await import("./startup-maintenance.js");
            if (!(await handleGatewayStartupMaintenance(error))) {
              throw error;
            }
          }
        },
        { deferInspections: !resolved.updateCanary },
      );
    });
}
