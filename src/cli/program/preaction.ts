// Global Commander pre-action hook: startup presentation, config guard, logging, and plugin preflight.
import type { Command } from "commander";
import type { StartupConfigPreflightOptions } from "../../commands/startup-config-preflight.js";
import { setVerbose } from "../../globals.js";
import type { LogLevel } from "../../logging/levels.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveCliArgvInvocation } from "../argv-invocation.js";
import { getVerboseFlag, isHelpOrVersionInvocation } from "../argv.js";
import { CLI_NAME } from "../cli-name.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
} from "../command-execution-startup.js";
import { resolveCliCommandPathPolicy } from "../command-path-policy.js";
import { resolveCliStartupPolicy } from "../command-startup-policy.js";
import { applyResolvedCommandOutputMode } from "../json-output-mode.js";
import { isModelsPlainMachineOutput } from "../models-output-mode.js";
import { getCommanderCommandPath, hasCommanderOptionToken } from "./commander-parse-facts.js";
import { isCommandJsonOutputMode } from "./json-mode.js";
import { isParentDefaultHelpAction } from "./parent-default-help.js";

const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "-V", "--version"]);

// Every CLI invocation presents as `openclaw` in process listings instead of `node`; only the
// long-running Gateway takes a distinct title (see gateway-cli/run-loop.ts), so lock readers and
// operators can tell it apart from ordinary commands.
function setProcessTitleForCommand() {
  if (process.title !== CLI_NAME) {
    process.title = CLI_NAME;
  }
}

function getCliLogLevel(actionCommand: Command): LogLevel | undefined {
  if (actionCommand.getOptionValueSourceWithGlobals("logLevel") !== "cli") {
    return undefined;
  }
  const logLevel = actionCommand.optsWithGlobals<{ logLevel?: unknown }>().logLevel;
  return typeof logLevel === "string" ? (logLevel as LogLevel) : undefined;
}

function isBareParentDefaultHelpInvocation(actionCommand: Command, argv: string[]): boolean {
  if (!isParentDefaultHelpAction(actionCommand)) {
    return false;
  }
  const { commandPath } = resolveCliArgvInvocation(argv);
  const [primary, extra] = commandPath;
  if (extra !== undefined || !primary) {
    return false;
  }
  return primary === actionCommand.name() || actionCommand.aliases().includes(primary);
}

function isGuidedConfigCommandPath(commandPath: string[]): boolean {
  const [primary, secondary, extra] = commandPath;
  if (primary !== "config" || extra !== undefined) {
    return false;
  }
  return (
    secondary !== "get" &&
    secondary !== "set" &&
    secondary !== "patch" &&
    secondary !== "unset" &&
    secondary !== "file" &&
    secondary !== "schema" &&
    secondary !== "validate"
  );
}

async function runStateStoreGuard(commandPath: string[]): Promise<void> {
  if (resolveCliCommandPathPolicy(commandPath).stateStoreGuard !== "run") {
    return;
  }
  let outcome: import("../state-dir-gateway-check.js").CliGatewayStateDirOutcome;
  try {
    const { checkCliGatewayStateDir } = await import("../state-dir-gateway-check.js");
    outcome = await checkCliGatewayStateDir({ command: `openclaw ${commandPath.join(" ")}` });
  } catch (error) {
    const { formatErrorMessage } = await import("../../infra/errors.js");
    const { logDebug } = await import("../../logger.js");
    logDebug(`state-store guard unavailable: ${formatErrorMessage(error)}`);
    return;
  }
  if (outcome.kind === "warn") {
    defaultRuntime.log(outcome.message);
  } else if (outcome.kind === "refuse") {
    throw new Error(outcome.message);
  }
}

/** Register global pre-action bootstrap hooks for every non-help command invocation. */
export function registerPreActionHooks(program: Command, programVersion: string) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    setProcessTitleForCommand();
    const argv = process.argv;
    const helpOrVersionWasOptionValue = hasCommanderOptionToken(
      actionCommand,
      argv,
      HELP_OR_VERSION_FLAGS,
      "value",
    );
    if (
      (isHelpOrVersionInvocation(argv) && !helpOrVersionWasOptionValue) ||
      isBareParentDefaultHelpInvocation(actionCommand, argv)
    ) {
      return;
    }
    const commandPath = getCommanderCommandPath(actionCommand);
    const nativeUpdateExecutorCheck =
      commandPath.length === 2 &&
      (commandPath[0] === "gateway" || commandPath[0] === "daemon") &&
      ["install", "restart", "stop"].includes(commandPath[1] ?? "") &&
      actionCommand.args.length === 0 &&
      actionCommand.getOptionValueSource("updateExecutor") === "cli" &&
      actionCommand.getOptionValue("updateExecutor") === "check";
    const jsonOutputMode =
      nativeUpdateExecutorCheck || isCommandJsonOutputMode(actionCommand, argv);
    const machineOutputMode = jsonOutputMode || isModelsPlainMachineOutput(argv, actionCommand);
    applyResolvedCommandOutputMode(jsonOutputMode, machineOutputMode);
    const startupPolicy = resolveCliStartupPolicy({
      argv,
      options: actionCommand.opts(),
      commandPath,
      jsonOutputMode,
      machineOutputMode,
      env: process.env,
      nativeUpdateExecutorCheck,
    });
    await applyCliExecutionStartupPresentation({
      startupPolicy,
      version: programVersion,
    });
    const verbose = getVerboseFlag(argv);
    setVerbose(verbose);
    const cliLogLevel = getCliLogLevel(actionCommand);
    if (cliLogLevel) {
      process.env.OPENCLAW_LOG_LEVEL = cliLogLevel;
    }
    if (!verbose) {
      process.env.NODE_NO_WARNINGS ??= "1";
    }
    // Capability discovery precedes staged-update admission and must not migrate live state.
    if (nativeUpdateExecutorCheck || isGuidedConfigCommandPath(commandPath)) {
      return;
    }
    await runStateStoreGuard(commandPath);
    if (startupPolicy.skipConfigGuard) {
      // Config validation and plugin activation are independent startup policies.
      // A cold config read must not suppress a plugin runtime explicitly required by the command.
      await ensureCliExecutionBootstrap({
        runtime: defaultRuntime,
        commandPath,
        startupPolicy,
        skipConfigGuard: true,
      });
      return;
    }
    let beforeStatePreparation: StartupConfigPreflightOptions["beforeStatePreparation"];
    const [{ resolvePluginInstallInvalidConfigPolicy }, { resolvePluginInstallPreactionRequest }] =
      await Promise.all([
        import("../../plugins/install-config.js"),
        import("../plugin-install-config-policy.js"),
      ]);
    let allowInvalid =
      commandPath[0] === "update" ||
      resolvePluginInstallInvalidConfigPolicy(
        resolvePluginInstallPreactionRequest({ actionCommand, commandPath, argv: process.argv }),
      ) === "allow-plugin-recovery";
    const isGatewayRun =
      commandPath[0] === "gateway" &&
      (commandPath.length === 1 || (commandPath.length === 2 && commandPath[1] === "run"));
    if (isGatewayRun) {
      const { prepareGatewayRunBootstrap, recheckGatewayRunBootstrap } =
        await import("../gateway-cli/pre-bootstrap.js");
      const { resolveGatewayRunOptions } = await import("../gateway-cli/run-options.js");
      const opts = resolveGatewayRunOptions(actionCommand.opts(), actionCommand);
      allowInvalid ||= opts.allowUnconfigured === true;
      const shouldBootstrap = await prepareGatewayRunBootstrap({ opts, runtime: defaultRuntime });
      if (!shouldBootstrap) {
        return;
      }
      beforeStatePreparation = (snapshot) =>
        recheckGatewayRunBootstrap({
          opts,
          runtime: defaultRuntime,
          ...(snapshot ? { snapshot } : {}),
        });
    }
    await ensureCliExecutionBootstrap({
      runtime: defaultRuntime,
      commandPath,
      startupPolicy,
      allowInvalid,
      ...(beforeStatePreparation ? { beforeStatePreparation } : {}),
    });
    if (beforeStatePreparation) {
      const { reloadTrustedGatewayRunEnvironment } =
        await import("../gateway-cli/pre-bootstrap.js");
      await reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime });
    }
  });
}
