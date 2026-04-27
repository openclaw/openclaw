import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Command } from "commander";
import { setVerbose } from "../../globals.js";
import type { LogLevel } from "../../logging/levels.js";
import { defaultRuntime } from "../../runtime.js";
import { getVerboseFlag, hasHelpOrVersion } from "../argv.js";
import { resolveCliName } from "../cli-name.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
  resolveCliExecutionStartupContext,
} from "../command-execution-startup.js";
import { shouldBypassConfigGuardForCommandPath } from "../command-startup-policy.js";
import {
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallPreactionRequest,
} from "../plugin-install-config-policy.js";
import { isCommandJsonOutputMode } from "./json-mode.js";

const AGENT_EXEC_DEBUG_ENV = "OPENCLAW_AGENT_EXEC_DEBUG";
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "archived", "published"]);

function isAgentExecDebugEnabled(): boolean {
  return process.env[AGENT_EXEC_DEBUG_ENV] === "1";
}

function appendDispatchDebug(event: string, extra: Record<string, unknown> = {}) {
  if (!isAgentExecDebugEnabled()) {
    return;
  }
  fs.appendFileSync(
    "/tmp/openclaw-agent-exec-dispatch-debug.jsonl",
    `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, source: "preaction", event, ...extra })}\n`,
  );
}

function readOptionalJson(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function appendJobDebug(jobFolder: string, payload: Record<string, unknown>) {
  if (!isAgentExecDebugEnabled()) {
    return;
  }
  const debugPath = path.join(jobFolder, ".agent-exec-debug.jsonl");
  fs.appendFileSync(
    debugPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...payload })}\n`,
  );
}

function getCommandLineage(command: Command): string[] {
  const lineage: string[] = [];
  let current: Command | null = command;
  while (current) {
    const name = current.name();
    if (name) {
      lineage.push(name);
    }
    current = current.parent ?? null;
  }
  return lineage.toReversed();
}

function getEarlyAgentExecRefusal(
  actionCommand: Command,
  argv: string[],
): Record<string, unknown> | undefined {
  const commandName = actionCommand.name();
  const parentCommandName = actionCommand.parent?.name?.();
  const lineage = getCommandLineage(actionCommand);
  const commandPathFromInvocation = resolveCliExecutionStartupContext({
    argv,
    jsonOutputMode: isCommandJsonOutputMode(actionCommand, argv),
    env: process.env,
  }).commandPath;
  const opts = actionCommand.opts<Record<string, unknown>>();
  const isAgentExecCommand = commandName === "agent-exec" || lineage.includes("agent-exec");

  appendDispatchDebug("preaction_early_agent_exec_identity", {
    argv,
    command_name: commandName,
    parent_command_name: parentCommandName,
    command_lineage: lineage,
    command_path: commandPathFromInvocation,
    selected_command_path: lineage,
    parsed_options: opts,
    is_agent_exec_command: isAgentExecCommand,
  });

  if (!isAgentExecCommand) {
    appendDispatchDebug("preaction_early_agent_exec_refusal_skipped_not_agent_exec", {
      argv,
      command_name: commandName,
      parent_command_name: parentCommandName,
      command_lineage: lineage,
      command_path: commandPathFromInvocation,
      parsed_options: opts,
      early_refusal_eligible: false,
      ineligible_reason: "not_agent_exec_command",
    });
    return undefined;
  }

  if (opts.forceRerun === true) {
    appendDispatchDebug("preaction_early_agent_exec_refusal_skipped_force_rerun", {
      argv,
      command_name: commandName,
      parent_command_name: parentCommandName,
      command_lineage: lineage,
      command_path: commandPathFromInvocation,
      parsed_options: opts,
      resolved_force_rerun: true,
      early_refusal_eligible: false,
      ineligible_reason: "force_rerun_present",
    });
    return undefined;
  }

  const jobId = typeof opts.jobId === "string" ? opts.jobId.trim() : "";
  const jobPath = typeof opts.jobPath === "string" ? opts.jobPath.trim() : "";
  const agentId = typeof opts.agent === "string" ? opts.agent.trim() : "";
  if (!jobId || !jobPath) {
    appendDispatchDebug("preaction_early_agent_exec_refusal_skipped_missing_inputs", {
      argv,
      command_name: commandName,
      parent_command_name: parentCommandName,
      command_lineage: lineage,
      command_path: commandPathFromInvocation,
      parsed_options: opts,
      resolved_job_path: jobPath,
      resolved_force_rerun: false,
      early_refusal_eligible: false,
      ineligible_reason: "missing_job_id_or_job_path",
    });
    return undefined;
  }

  const resolvedJobPath = path.resolve(jobPath);
  if (!fs.existsSync(resolvedJobPath)) {
    appendDispatchDebug("preaction_early_agent_exec_refusal_skipped_missing_job_path", {
      argv,
      command_name: commandName,
      parent_command_name: parentCommandName,
      command_lineage: lineage,
      command_path: commandPathFromInvocation,
      parsed_options: opts,
      resolved_job_path: resolvedJobPath,
      resolved_force_rerun: false,
      early_refusal_eligible: false,
      ineligible_reason: "resolved_job_path_missing",
    });
    return undefined;
  }

  const jobFolder = path.dirname(resolvedJobPath);
  const lockPath = path.join(jobFolder, ".agent-exec.lock.json");
  const job = readOptionalJson(resolvedJobPath);
  const proof = readOptionalJson(path.join(jobFolder, "agent-proof.json"));
  const jobStatus = job?.status;
  const proofReady = proof?.ready_for_dom_review === true;
  const terminalEligible =
    typeof jobStatus === "string" && TERMINAL_JOB_STATUSES.has(jobStatus.trim().toLowerCase());
  const earlyEligible = terminalEligible || proofReady;

  appendDispatchDebug("preaction_early_agent_exec_refusal_check", {
    argv,
    command_name: commandName,
    parent_command_name: parentCommandName,
    command_lineage: lineage,
    command_path: commandPathFromInvocation,
    parsed_options: opts,
    resolved_job_path: resolvedJobPath,
    resolved_force_rerun: false,
    job_id: jobId,
    job_status: jobStatus,
    proof_ready: proofReady,
    early_refusal_eligible: earlyEligible,
    ineligible_reason: earlyEligible ? undefined : "job_not_terminal_and_proof_not_ready",
  });
  appendJobDebug(jobFolder, {
    job_id: jobId,
    event: "preaction_early_refusal_check",
    command_name: commandName,
    parent_command_name: parentCommandName,
    command_lineage: lineage,
    command_path: commandPathFromInvocation,
    job_status: jobStatus,
    proof_ready: proofReady,
    force_rerun: false,
    early_refusal_eligible: earlyEligible,
  });

  let result: Record<string, unknown> | undefined;
  if (terminalEligible) {
    result = {
      state: "refused_terminal_state",
      agentId,
      jobId,
      jobPath: resolvedJobPath,
      jobFolder,
      lockPath,
      readyForDomReview: proofReady,
      claimedResult: typeof proof?.claimed_result === "string" ? proof.claimed_result : undefined,
      refusalReason: `Refusing to run agent-exec for terminal job status: ${jobStatus}`,
    };
    appendJobDebug(jobFolder, {
      job_id: jobId,
      event: "preaction_early_terminal_refusal_return",
      job_status: jobStatus,
      proof_ready: proofReady,
      force_rerun: false,
    });
  } else if (proofReady) {
    result = {
      state: "refused_proof_already_ready",
      agentId,
      jobId,
      jobPath: resolvedJobPath,
      jobFolder,
      lockPath,
      readyForDomReview: true,
      claimedResult: typeof proof?.claimed_result === "string" ? proof.claimed_result : undefined,
      refusalReason:
        "Refusing to run agent-exec because agent-proof.json is already ready for Dom review. Pass --force-rerun only for an intentional reset/retry flow.",
    };
    appendJobDebug(jobFolder, {
      job_id: jobId,
      event: "preaction_early_proof_ready_refusal_return",
      job_status: jobStatus,
      proof_ready: true,
      force_rerun: false,
    });
  }

  if (!result) {
    appendDispatchDebug("preaction_early_agent_exec_refusal_not_applicable", {
      argv,
      command_name: commandName,
      parent_command_name: parentCommandName,
      command_lineage: lineage,
      command_path: commandPathFromInvocation,
      parsed_options: opts,
      resolved_job_path: resolvedJobPath,
      resolved_force_rerun: false,
      job_id: jobId,
      job_status: jobStatus,
      proof_ready: proofReady,
      early_refusal_eligible: false,
      ineligible_reason: "job_not_terminal_and_proof_not_ready",
    });
    return undefined;
  }

  appendDispatchDebug("preaction_early_agent_exec_refusal_returning", {
    argv,
    command_name: commandName,
    parent_command_name: parentCommandName,
    command_lineage: lineage,
    command_path: commandPathFromInvocation,
    parsed_options: opts,
    resolved_job_path: resolvedJobPath,
    resolved_force_rerun: false,
    result_state: result.state,
    job_id: jobId,
    early_refusal_eligible: true,
  });
  return result;
}

function setProcessTitleForCommand(actionCommand: Command) {
  let current: Command = actionCommand;
  while (current.parent && current.parent.parent) {
    current = current.parent;
  }
  const name = current.name();
  const cliName = resolveCliName();
  if (!name || name === cliName) {
    return;
  }
  process.title = `${cliName}-${name}`;
}

function shouldAllowInvalidConfigForAction(actionCommand: Command, commandPath: string[]): boolean {
  return (
    resolvePluginInstallInvalidConfigPolicy(
      resolvePluginInstallPreactionRequest({
        actionCommand,
        commandPath,
        argv: process.argv,
      }),
    ) === "allow-bundled-recovery"
  );
}

function getRootCommand(command: Command): Command {
  let current = command;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function getCliLogLevel(actionCommand: Command): LogLevel | undefined {
  const root = getRootCommand(actionCommand);
  if (typeof root.getOptionValueSource !== "function") {
    return undefined;
  }
  if (root.getOptionValueSource("logLevel") !== "cli") {
    return undefined;
  }
  const logLevel = root.opts<Record<string, unknown>>().logLevel;
  return typeof logLevel === "string" ? (logLevel as LogLevel) : undefined;
}

export function registerPreActionHooks(program: Command, programVersion: string) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    appendDispatchDebug("preaction_hook_enter", {
      argv: process.argv,
      selected_command: actionCommand.name(),
      parent_command: actionCommand.parent?.name?.(),
      command_lineage: getCommandLineage(actionCommand),
    });
    setProcessTitleForCommand(actionCommand);
    const argv = process.argv;
    if (hasHelpOrVersion(argv)) {
      appendDispatchDebug("preaction_hook_help_or_version_bypass", { argv });
      return;
    }

    const earlyRefusal = getEarlyAgentExecRefusal(actionCommand, argv);
    if (earlyRefusal) {
      process.stdout.write(`${JSON.stringify(earlyRefusal, null, 2)}\n`);
      process.exit(0);
    }

    const jsonOutputMode = isCommandJsonOutputMode(actionCommand, argv);
    const { commandPath, startupPolicy } = resolveCliExecutionStartupContext({
      argv,
      jsonOutputMode,
      env: process.env,
    });
    appendDispatchDebug("preaction_hook_after_startup_context", {
      argv,
      json_output_mode: jsonOutputMode,
      command_path: commandPath,
      startup_policy: startupPolicy,
    });
    await applyCliExecutionStartupPresentation({
      startupPolicy,
      version: programVersion,
    });
    appendDispatchDebug("preaction_hook_after_startup_presentation", {
      argv,
      command_path: commandPath,
    });
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    setVerbose(verbose);
    const cliLogLevel = getCliLogLevel(actionCommand);
    if (cliLogLevel) {
      process.env.OPENCLAW_LOG_LEVEL = cliLogLevel;
    }
    if (!verbose) {
      process.env.NODE_NO_WARNINGS ??= "1";
    }
    if (shouldBypassConfigGuardForCommandPath(commandPath)) {
      appendDispatchDebug("preaction_hook_bypass_config_guard", {
        argv,
        command_path: commandPath,
      });
      return;
    }
    appendDispatchDebug("preaction_hook_before_execution_bootstrap", {
      argv,
      command_path: commandPath,
    });
    await ensureCliExecutionBootstrap({
      runtime: defaultRuntime,
      commandPath,
      startupPolicy,
      allowInvalid: shouldAllowInvalidConfigForAction(actionCommand, commandPath),
    });
    appendDispatchDebug("preaction_hook_after_execution_bootstrap", {
      argv,
      command_path: commandPath,
    });
  });
}
