import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { appendAgentExecDebug } from "./agent-exec-debug.js";

const AGENT_EXEC_CONFIG_CONTEXT_ENV = "OPENCLAW_ACTIVE_AGENT_EXEC_CONFIG_CONTEXT";
import {
  ensureCliPluginRegistryLoaded,
  resolvePluginRegistryScopeForCommandPath,
} from "./plugin-registry-loader.js";

let configGuardModulePromise: Promise<typeof import("./program/config-guard.js")> | undefined;

function appendBootstrapJobDebug(event: string, extra: Record<string, unknown> = {}) {
  let jobStatus: unknown;
  let proofReady = false;
  const argv = process.argv;
  const jobPathIndex = argv.indexOf("--job-path");
  const jobPathValue = jobPathIndex >= 0 ? argv[jobPathIndex + 1] : undefined;
  if (typeof jobPathValue === "string" && jobPathValue.trim().length > 0) {
    const jobPath = path.resolve(jobPathValue);
    const jobFolder = path.dirname(jobPath);
    try {
      const job = JSON.parse(fs.readFileSync(jobPath, "utf8")) as Record<string, unknown>;
      jobStatus = job.status;
    } catch {}
    try {
      const proofPath = path.join(jobFolder, "agent-proof.json");
      if (fs.existsSync(proofPath)) {
        const proof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as Record<string, unknown>;
        proofReady = proof.ready_for_dom_review === true;
      }
    } catch {}
  }
  appendAgentExecDebug("command-bootstrap", event, {
    command_name: "agent-exec",
    job_status: jobStatus,
    proof_ready: proofReady,
    force_rerun: false,
    early_refusal_eligible: false,
    ...extra,
  });
}

function loadConfigGuardModule() {
  configGuardModulePromise ??= import("./program/config-guard.js");
  return configGuardModulePromise;
}

function readAgentExecBootstrapContext(): Record<string, unknown> | undefined {
  const raw = process.env[AGENT_EXEC_CONFIG_CONTEXT_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function ensureCliCommandBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  suppressDoctorStdout?: boolean;
  skipConfigGuard?: boolean;
  allowInvalid?: boolean;
  loadPlugins?: boolean;
  skipLegacyPluginDoctorRules?: boolean;
}) {
  appendBootstrapJobDebug("ensureCliCommandBootstrap_enter", { command_path: params.commandPath });
  try {
    if (!params.skipConfigGuard) {
      appendBootstrapJobDebug("ensureCliCommandBootstrap_before_loadConfigGuardModule", {
        command_path: params.commandPath,
      });
      const { ensureConfigReady } = await loadConfigGuardModule();
      appendBootstrapJobDebug("ensureCliCommandBootstrap_after_loadConfigGuardModule", {
        command_path: params.commandPath,
      });
      appendBootstrapJobDebug("ensureCliCommandBootstrap_before_ensureConfigReady", {
        command_path: params.commandPath,
      });
      await ensureConfigReady({
        runtime: params.runtime,
        commandPath: params.commandPath,
        ...(params.allowInvalid ? { allowInvalid: true } : {}),
        ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
        ...(params.skipLegacyPluginDoctorRules ? { skipLegacyPluginDoctorRules: true } : {}),
      });
      appendBootstrapJobDebug("ensureCliCommandBootstrap_after_ensureConfigReady", {
        command_path: params.commandPath,
      });
      appendBootstrapJobDebug("ensureCliCommandBootstrap_after_config_guard", {
        command_path: params.commandPath,
      });
    }
    const agentExecBootstrapContext = readAgentExecBootstrapContext();
    const commandName =
      typeof agentExecBootstrapContext?.command === "string"
        ? agentExecBootstrapContext.command
        : params.commandPath[0];
    const toolPolicy =
      typeof agentExecBootstrapContext?.toolPolicy === "string"
        ? agentExecBootstrapContext.toolPolicy
        : undefined;
    const skipPluginRegistry = commandName === "agent-exec" && toolPolicy === "coordination_only";
    appendBootstrapJobDebug("ensureCliCommandBootstrap_before_plugin_policy_decision", {
      command_path: params.commandPath,
      command_name: commandName,
      agent_id: agentExecBootstrapContext?.agent,
      job_id: agentExecBootstrapContext?.jobId,
      job_path: agentExecBootstrapContext?.jobPath,
      tool_policy: toolPolicy,
      load_plugins: Boolean(params.loadPlugins),
      skip_plugin_registry: skipPluginRegistry,
      reason: skipPluginRegistry
        ? "coordination_only_agent_exec"
        : toolPolicy
          ? "plugin_registry_required_for_command_or_tool_policy"
          : "plugin_policy_unmodified",
    });
    if (!params.loadPlugins) {
      appendBootstrapJobDebug("ensureCliCommandBootstrap_skip_plugin_load", {
        command_path: params.commandPath,
      });
      appendBootstrapJobDebug("ensureCliCommandBootstrap_after_plugin_policy_decision", {
        command_path: params.commandPath,
        command_name: commandName,
        tool_policy: toolPolicy,
        skip_plugin_registry: false,
        reason: "load_plugins_false",
      });
      appendBootstrapJobDebug("ensureCliCommandBootstrap_before_return", {
        command_path: params.commandPath,
        plugin_bootstrap_ran: false,
      });
      return;
    }
    if (skipPluginRegistry) {
      appendBootstrapJobDebug("ensureCliCommandBootstrap_skip_plugin_registry_coordination_only", {
        command_path: params.commandPath,
        command_name: commandName,
        agent_id: agentExecBootstrapContext?.agent,
        job_id: agentExecBootstrapContext?.jobId,
        job_path: agentExecBootstrapContext?.jobPath,
        tool_policy: toolPolicy,
        skip_plugin_registry: true,
        reason: "coordination_only_agent_exec",
      });
      appendBootstrapJobDebug("ensureCliCommandBootstrap_after_plugin_policy_decision", {
        command_path: params.commandPath,
        command_name: commandName,
        tool_policy: toolPolicy,
        skip_plugin_registry: true,
        reason: "coordination_only_agent_exec",
      });
      appendBootstrapJobDebug("ensureCliCommandBootstrap_before_return", {
        command_path: params.commandPath,
        plugin_bootstrap_ran: false,
      });
      return;
    }
    appendBootstrapJobDebug("ensureCliCommandBootstrap_plugin_registry_required", {
      command_path: params.commandPath,
      command_name: commandName,
      agent_id: agentExecBootstrapContext?.agent,
      job_id: agentExecBootstrapContext?.jobId,
      job_path: agentExecBootstrapContext?.jobPath,
      tool_policy: toolPolicy,
      skip_plugin_registry: false,
      reason: "normal_plugin_bootstrap_path",
    });
    appendBootstrapJobDebug("ensureCliCommandBootstrap_after_plugin_policy_decision", {
      command_path: params.commandPath,
      command_name: commandName,
      tool_policy: toolPolicy,
      skip_plugin_registry: false,
      reason: "plugin_registry_required",
    });
    appendBootstrapJobDebug("ensureCliCommandBootstrap_before_plugin_registry_load", {
      command_path: params.commandPath,
    });
    await ensureCliPluginRegistryLoaded({
      scope: resolvePluginRegistryScopeForCommandPath(params.commandPath),
      routeLogsToStderr: params.suppressDoctorStdout,
    });
    appendBootstrapJobDebug("ensureCliCommandBootstrap_after_plugin_registry_load", {
      command_path: params.commandPath,
    });
    appendBootstrapJobDebug("ensureCliCommandBootstrap_after_plugin_bootstrap", {
      command_path: params.commandPath,
    });
    appendBootstrapJobDebug("ensureCliCommandBootstrap_before_return", {
      command_path: params.commandPath,
      plugin_bootstrap_ran: true,
    });
  } catch (error) {
    appendBootstrapJobDebug("ensureCliCommandBootstrap_error", {
      command_path: params.commandPath,
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    appendBootstrapJobDebug("ensureCliCommandBootstrap_finally", {
      command_path: params.commandPath,
    });
  }
}
