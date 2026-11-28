import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTransientSqliteBackupPath } from "../infra/backup-volatile-filter.js";
import { readAgentDeletionRecoveryHoldsInWorker } from "../state/agent-deletion-journal.read.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";

/** Doctor's restore-first guidance for one store it holds back after deletion history was lost. */
export function formatHeldAgentStoreGuidance(
  target: { agentId: string; path: string },
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string {
  if (isTransientSqliteBackupPath(target.path)) {
    return sanitizeForLog(
      `${target.path}: internal SQLite coordination artifact; preserved without agent restoration or deletion.`,
    );
  }
  if (isReservedSystemAgentId(target.agentId)) {
    return sanitizeForLog(
      `${target.path}: ${target.agentId} is a reserved system agent and cannot be added or deleted. Run ${formatCliCommand("openclaw doctor --fix", env)} to restore its canonical store after ownership, integrity, and backup verification; unverified stores remain untouched.`,
    );
  }
  const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
  const workspace = resolveAgentWorkspaceDir(cfg, target.agentId, env);
  const agentDir = listAgentIds(cfg).includes(target.agentId)
    ? resolveAgentDir(cfg, target.agentId, env)
    : path.dirname(target.path);
  const restore = formatCliCommand(
    `openclaw agents add ${quote(target.agentId)} --workspace ${quote(workspace)} --agent-dir ${quote(agentDir)} --non-interactive`,
    env,
  );
  return sanitizeForLog(
    `${target.path}: ${path.basename(target.path) === "openclaw-agent.sqlite" ? "verify the workspace" : "restore the original session.store configuration for this database and verify the workspace"}, then run ${restore} to abort deletion and restore; after restoration, run ${formatCliCommand(`openclaw agents delete ${quote(target.agentId)} --force`, env)} to confirm deletion instead.`,
  );
}

/** Doctor's guidance for each of the agent's stores in its recorded recovery holds. */
export async function describeHeldAgentStores(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  return (await readAgentDeletionRecoveryHoldsInWorker({ env }))
    .filter((hold) => hold.agentId === agentId)
    .map((hold) => formatHeldAgentStoreGuidance(hold, cfg, env));
}
