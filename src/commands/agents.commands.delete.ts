import path from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import { writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { createQuietRuntime, requireValidConfig } from "./agents.command-shared.js";
import { findAgentEntryIndex, listAgentEntries, pruneAgentConfig } from "./agents.config.js";
import { moveToTrash } from "./onboard-helpers.js";

type AgentsDeleteOptions = {
  id: string;
  force?: boolean;
  json?: boolean;
};

export async function agentsDeleteCommand(
  opts: AgentsDeleteOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const input = opts.id?.trim();
  if (!input) {
    runtime.error("Agent id is required.");
    runtime.exit(1);
    return;
  }

  const agentId = normalizeAgentId(input);
  if (agentId !== input) {
    runtime.log(`Normalized agent id to "${agentId}".`);
  }
  if (agentId === DEFAULT_AGENT_ID) {
    runtime.error(`"${DEFAULT_AGENT_ID}" cannot be deleted.`);
    runtime.exit(1);
    return;
  }

  if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
    runtime.error(`Agent "${agentId}" not found.`);
    runtime.exit(1);
    return;
  }

  if (!opts.force) {
    if (!process.stdin.isTTY) {
      runtime.error("Non-interactive session. Re-run with --force.");
      runtime.exit(1);
      return;
    }
    const prompter = createClackPrompter();
    const confirmed = await prompter.confirm({
      message: `Delete agent "${agentId}" and prune workspace/state?`,
      initialValue: false,
    });
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = resolveAgentDir(cfg, agentId);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

  const result = pruneAgentConfig(cfg, agentId);
  await writeConfigFile(result.config);
  if (!opts.json) {
    logConfigUpdated(runtime);
  }

  const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
  // Guard: do not delete the shared default workspace — it may be used by other agents.
  // Skip workspace deletion if:
  // 1. workspaceDir equals the shared default workspace, OR
  // 2. the default agent also uses this workspace path (indicating it is a shared custom workspace)
  const isDefaultWorkspace =
    path.normalize(workspaceDir) === path.normalize(DEFAULT_AGENT_WORKSPACE_DIR);
  const defaultAgentWorkspace = isDefaultWorkspace
    ? workspaceDir
    : resolveAgentWorkspaceDir(cfg, DEFAULT_AGENT_ID);
  const isSharedWorkspace =
    isDefaultWorkspace || path.normalize(workspaceDir) === path.normalize(defaultAgentWorkspace);
  if (!isSharedWorkspace) {
    await moveToTrash(workspaceDir, quietRuntime);
  } else if (!opts.json) {
    runtime.log(
      `Skipped deleting shared workspace "${workspaceDir}" — it is used by the default agent or other agents. Only agent-specific state was removed.`,
    );
  }
  await moveToTrash(agentDir, quietRuntime);
  await moveToTrash(sessionsDir, quietRuntime);

  if (opts.json) {
    writeRuntimeJson(runtime, {
      agentId,
      workspace: workspaceDir,
      agentDir,
      sessionsDir,
      removedBindings: result.removedBindings,
      removedAllow: result.removedAllow,
    });
  } else {
    runtime.log(`Deleted agent: ${agentId}`);
  }
}
