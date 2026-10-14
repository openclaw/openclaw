import {
  listAgentEntries,
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveEffectiveAgentDir,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import { resolveSessionStorePathCore } from "./sessions/paths.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export class AgentDeletionTargetsPendingError extends Error {}

/** Gateway deletion captures its targets under the same lock as config writers. */
export async function assertAgentDeletionTargetsUnchanged(
  sourceConfig: OpenClawConfig,
  targetConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const existing = new Set(listAgentIds(sourceConfig));
  const candidates = new Set(listAgentIds(targetConfig));
  if (sourceConfig.session?.store !== targetConfig.session?.store) {
    const { listPendingAgentDeletionJournalsAsync } =
      await import("../state/agent-deletion-journal.js");
    const { entries, manualClawAgentIds } = await listPendingAgentDeletionJournalsAsync({ env });
    for (const agentId of [...entries.map((entry) => entry.agentId), ...manualClawAgentIds]) {
      if (
        resolveSessionStorePathCore(sourceConfig.session?.store, { agentId, env }) !==
        resolveSessionStorePathCore(targetConfig.session?.store, { agentId, env })
      ) {
        candidates.add(agentId);
      }
    }
  }
  for (const agentId of candidates) {
    if (
      existing.has(agentId) &&
      resolveAgentWorkspaceDir(sourceConfig, agentId, env) ===
        resolveAgentWorkspaceDir(targetConfig, agentId, env) &&
      resolveEffectiveAgentDir(sourceConfig, agentId, { env }) ===
        resolveEffectiveAgentDir(targetConfig, agentId, { env }) &&
      resolveSessionStorePathCore(sourceConfig.session?.store, { agentId, env }) ===
        resolveSessionStorePathCore(targetConfig.session?.store, { agentId, env })
    ) {
      continue;
    }
    if ((await readAgentDeletionJournalStatusInWorker(agentId, { env })) === "pending") {
      throw new AgentDeletionTargetsPendingError(
        `Agent "${agentId}" deletion cleanup is still pending; finish or retry its deletion before changing its workspace, agent directory, or session store.`,
      );
    }
  }
}

export function pinSurvivorWorkspaceForRosterCollapse(
  sourceConfig: OpenClawConfig,
  targetConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): { config: OpenClawConfig; insertedPaths: string[][] } {
  const sourceEntries = listAgentEntries(sourceConfig);
  const targetEntries = listAgentEntries(targetConfig);
  if (sourceEntries.length <= 1 || targetEntries.length !== 1) {
    return { config: targetConfig, insertedPaths: [] };
  }

  const survivorId = normalizeAgentId(targetEntries[0]!.id);
  if (!sourceEntries.some((entry) => normalizeAgentId(entry.id) === survivorId)) {
    return { config: targetConfig, insertedPaths: [] };
  }

  const targetAgents = targetConfig.agents ?? {};
  const entries = targetAgents.entries
    ? { ...targetAgents.entries }
    : toAgentEntriesRecord(targetEntries);
  const entryKey = Object.keys(entries).find(
    (candidate) => normalizeAgentId(candidate) === survivorId,
  );
  const entry = entryKey ? entries[entryKey] : undefined;
  const workspaceNeedsPin =
    entry !== undefined &&
    (!Object.hasOwn(entry, "workspace") ||
      (typeof entry.workspace === "string" && entry.workspace.trim().length === 0));
  if (!entryKey || !entry || !workspaceNeedsPin) {
    return { config: targetConfig, insertedPaths: [] };
  }

  // Resolve against the old multi-agent topology before sole-agent inheritance
  // can move the survivor from its per-agent workspace to the shared root.
  entries[entryKey] = {
    ...entry,
    workspace: resolveAgentWorkspaceDir(sourceConfig, survivorId, env),
  };
  return {
    config: {
      ...targetConfig,
      agents: { ...targetAgents, entries },
    },
    insertedPaths: [["agents", "entries", entryKey, "workspace"]],
  };
}
