import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Command } from "commander";
import { setVerbose } from "../../globals.js";
import type { LogLevel } from "../../logging/levels.js";
import { defaultRuntime } from "../../runtime.js";
import { appendAgentExecDebug, isAgentExecDebugEnabled } from "../agent-exec-debug.js";
import { getFlagValue, getVerboseFlag, hasHelpOrVersion } from "../argv.js";
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

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "archived", "published"]);

const AGENT_EXEC_CONFIG_CONTEXT_ENV = "OPENCLAW_ACTIVE_AGENT_EXEC_CONFIG_CONTEXT";

function appendDispatchDebug(event: string, extra: Record<string, unknown> = {}) {
  appendAgentExecDebug("preaction", event, extra);
}

function buildPrebootstrapAgentExecConfigContext(
  argv: string[],
  commandPath: string[],
): string | undefined {
  if (commandPath[0] !== "agent-exec") {
    return undefined;
  }
  const jobId = getFlagValue(argv, "--job-id") ?? undefined;
  const jobPath = getFlagValue(argv, "--job-path") ?? undefined;
  const agent = getFlagValue(argv, "--agent") ?? undefined;
  if (!jobId || !jobPath || !agent) {
    appendDispatchDebug("agentExecBootstrapContext_missing_tool_policy", {
      command_name: commandPath[0],
      agent_id: agent,
      job_id: jobId,
      job_path: jobPath ? path.resolve(jobPath) : undefined,
      tool_policy: undefined,
      skip_plugin_registry: false,
      reason: "missing_job_id_job_path_or_agent",
    });
    return undefined;
  }
  const resolvedJobPath = path.resolve(jobPath);
  const job = fs.existsSync(resolvedJobPath) ? readOptionalJson(resolvedJobPath) : undefined;
  const cliToolPolicy = getFlagValue(argv, "--tool-policy") ?? undefined;
  const toolPolicy =
    typeof cliToolPolicy === "string" && cliToolPolicy.trim().length > 0
      ? cliToolPolicy.trim()
      : typeof job?.context === "object" &&
          job.context !== null &&
          typeof (job.context as Record<string, unknown>).tool_policy === "string"
        ? ((job.context as Record<string, unknown>).tool_policy as string).trim()
        : undefined;
  if (!toolPolicy) {
    appendDispatchDebug("agentExecBootstrapContext_missing_tool_policy", {
      command_name: commandPath[0],
      agent_id: agent,
      job_id: jobId,
      job_path: resolvedJobPath,
      tool_policy: undefined,
      skip_plugin_registry: false,
      reason: "cli_and_job_context_tool_policy_missing",
    });
    return undefined;
  }
  const context = {
    command: "agent-exec",
    jobId,
    jobPath: resolvedJobPath,
    agent,
    skipLegacyPluginDoctorRules: true,
    toolPolicy,
    source: "preaction",
  };
  appendDispatchDebug("agentExecBootstrapContext_resolved", {
    command_name: commandPath[0],
    agent_id: agent,
    job_id: jobId,
    job_path: resolvedJobPath,
    tool_policy: toolPolicy,
    skip_plugin_registry: toolPolicy === "coordination_only",
    reason:
      toolPolicy === "coordination_only"
        ? cliToolPolicy
          ? "coordination_only_cli_flag"
          : "coordination_only_job_context"
        : "tool_policy_requires_normal_plugin_bootstrap",
  });
  return JSON.stringify(context);
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
    appendJobDebug(jobFolder, {
      job_id: jobId,
      event: "preaction_no_refusal_continue",
      command_name: commandName,
      parent_command_name: parentCommandName,
      command_lineage: lineage,
      command_path: commandPathFromInvocation,
      job_status: jobStatus,
      proof_ready: proofReady,
      force_rerun: false,
      early_refusal_eligible: false,
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

    const agentExecOpts =
      actionCommand.name() === "agent-exec"
        ? actionCommand.opts<Record<string, unknown>>()
        : undefined;
    const agentExecJobId =
      typeof agentExecOpts?.jobId === "string" ? agentExecOpts.jobId.trim() : "";
    const agentExecJobPath =
      typeof agentExecOpts?.jobPath === "string" ? path.resolve(agentExecOpts.jobPath.trim()) : "";
    const agentExecJobFolder = agentExecJobPath ? path.dirname(agentExecJobPath) : "";
    const agentExecJob =
      agentExecJobPath && fs.existsSync(agentExecJobPath)
        ? readOptionalJson(agentExecJobPath)
        : undefined;
    const agentExecProof = agentExecJobFolder
      ? readOptionalJson(path.join(agentExecJobFolder, "agent-proof.json"))
      : undefined;
    const agentExecJobStatus = agentExecJob?.status;
    const agentExecProofReady = agentExecProof?.ready_for_dom_review === true;
    const agentExecEarlyEligible =
      (typeof agentExecJobStatus === "string" &&
        TERMINAL_JOB_STATUSES.has(agentExecJobStatus.trim().toLowerCase())) ||
      agentExecProofReady;
    if (agentExecJobFolder) {
      appendJobDebug(agentExecJobFolder, {
        job_id: agentExecJobId,
        event: "preaction_before_config_bootstrap",
        command_name: actionCommand.name(),
        job_status: agentExecJobStatus,
        proof_ready: agentExecProofReady,
        force_rerun: false,
        early_refusal_eligible: agentExecEarlyEligible,
      });
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
    const priorAgentExecConfigContext = process.env[AGENT_EXEC_CONFIG_CONTEXT_ENV];
    const nextAgentExecConfigContext = buildPrebootstrapAgentExecConfigContext(argv, commandPath);
    if (nextAgentExecConfigContext) {
      process.env[AGENT_EXEC_CONFIG_CONTEXT_ENV] = nextAgentExecConfigContext;
      appendDispatchDebug("preaction_agent_exec_config_context_set", {
        command_path: commandPath,
        context_source: "preaction",
        has_prior_context: typeof priorAgentExecConfigContext === "string",
      });
      appendDispatchDebug("direct_agent_exec_context_set", {
        command_path: commandPath,
        context_source: "preaction",
      });
    }
    try {
      await ensureCliExecutionBootstrap({
        runtime: defaultRuntime,
        commandPath,
        startupPolicy,
        allowInvalid: shouldAllowInvalidConfigForAction(actionCommand, commandPath),
      });
    } finally {
      if (nextAgentExecConfigContext) {
        if (typeof priorAgentExecConfigContext === "string") {
          process.env[AGENT_EXEC_CONFIG_CONTEXT_ENV] = priorAgentExecConfigContext;
        } else {
          delete process.env[AGENT_EXEC_CONFIG_CONTEXT_ENV];
        }
        appendDispatchDebug("preaction_agent_exec_config_context_cleared", {
          command_path: commandPath,
          restored_prior_context: typeof priorAgentExecConfigContext === "string",
        });
        appendDispatchDebug("direct_agent_exec_context_cleared", {
          command_path: commandPath,
          restored_prior_context: typeof priorAgentExecConfigContext === "string",
        });
      }
    }
    if (agentExecJobFolder) {
      appendJobDebug(agentExecJobFolder, {
        job_id: agentExecJobId,
        event: "preaction_after_config_bootstrap",
        command_name: actionCommand.name(),
        job_status: agentExecJobStatus,
        proof_ready: agentExecProofReady,
        force_rerun: false,
        early_refusal_eligible: agentExecEarlyEligible,
      });
      appendJobDebug(agentExecJobFolder, {
        job_id: agentExecJobId,
        event: "action_handler_expected",
        command_name: actionCommand.name(),
        job_status: agentExecJobStatus,
        proof_ready: agentExecProofReady,
        force_rerun: false,
        early_refusal_eligible: agentExecEarlyEligible,
      });
      appendJobDebug(agentExecJobFolder, {
        job_id: agentExecJobId,
        event: "preaction_before_return",
        command_name: actionCommand.name(),
        job_status: agentExecJobStatus,
        proof_ready: agentExecProofReady,
        force_rerun: false,
        early_refusal_eligible: agentExecEarlyEligible,
      });
    }
    appendDispatchDebug("preaction_hook_after_execution_bootstrap", {
      argv,
      command_path: commandPath,
    });
    appendDispatchDebug("preaction_hook_before_return", {
      argv,
      command_path: commandPath,
      selected_command: actionCommand.name(),
    });
  });
}
