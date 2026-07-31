import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { pinSoleAgentWorkspaceForFleetExpansion } from "./agent-workspace-ownership.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { materializeLegacyAgentOwnershipForActiveChannelsResult } from "./validation.js";

function pinRetainedFleetOwnerWorkspace(params: {
  sourceConfig: OpenClawConfig;
  targetConfig: OpenClawConfig;
  agentId: string;
}): { config: OpenClawConfig; insertedPaths: string[][] } {
  const agentId = normalizeAgentId(params.agentId);
  const sourceEntry = listAgentEntries(params.sourceConfig).find(
    (entry) => normalizeAgentId(entry.id) === agentId,
  );
  const sourceWorkspace =
    typeof sourceEntry?.workspace === "string" ? sourceEntry.workspace.trim() : "";
  const targetAgents = params.targetConfig.agents ?? {};
  const entries = targetAgents.entries
    ? { ...targetAgents.entries }
    : toAgentEntriesRecord(listAgentEntries(params.targetConfig));
  const entryKey = Object.keys(entries).find((key) => normalizeAgentId(key) === agentId);
  const entry = entryKey ? entries[entryKey] : undefined;
  const workspaceNeedsPin =
    entry !== undefined &&
    (!Object.hasOwn(entry, "workspace") ||
      (typeof entry.workspace === "string" && entry.workspace.trim().length === 0));
  if (!sourceWorkspace || !entry || !workspaceNeedsPin) {
    return { config: params.targetConfig, insertedPaths: [] };
  }
  entries[entryKey!] = { ...entry, workspace: sourceWorkspace };
  const { list: _legacyList, ...canonicalAgents } = targetAgents;
  return {
    config: { ...params.targetConfig, agents: { ...canonicalAgents, entries } },
    insertedPaths: [["agents", "entries", entryKey!, "workspace"]],
  };
}

/** Reinstates upgrade-owned roles before a topology write stamps explicit ownership. */
export function materializeRetainedOwnerForTopologyWrite(params: {
  sourceConfig: OpenClawConfig;
  targetConfig: OpenClawConfig;
  previousSoleHandoffAgentId?: string;
  retainedLegacyDefaultAgentId?: string;
  writesOwnershipTopology: boolean;
  nextAgentIds: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
}): {
  config: OpenClawConfig;
  insertedPaths: string[][];
  ownerAgentId?: string;
  pluginPath?: string;
} {
  const retainedFleetOwner =
    params.retainedLegacyDefaultAgentId &&
    params.writesOwnershipTopology &&
    params.nextAgentIds.has(normalizeAgentId(params.retainedLegacyDefaultAgentId))
      ? params.retainedLegacyDefaultAgentId
      : undefined;
  const ownerAgentId = params.previousSoleHandoffAgentId ?? retainedFleetOwner;
  if (!ownerAgentId) {
    return { config: params.targetConfig, insertedPaths: [] };
  }
  const workspacePin = params.previousSoleHandoffAgentId
    ? pinSoleAgentWorkspaceForFleetExpansion({
        sourceConfig: params.sourceConfig,
        targetConfig: params.targetConfig,
        agentId: ownerAgentId,
        env: params.env,
      })
    : pinRetainedFleetOwnerWorkspace({
        sourceConfig: params.sourceConfig,
        targetConfig: params.targetConfig,
        agentId: ownerAgentId,
      });
  const materialized = materializeLegacyAgentOwnershipForActiveChannelsResult(
    workspacePin.config,
    ownerAgentId,
    params.env,
    undefined,
    { materializeWorkspace: true },
  );
  const pluginPath =
    params.previousSoleHandoffAgentId &&
    "pluginPath" in workspacePin &&
    typeof workspacePin.pluginPath === "string"
      ? workspacePin.pluginPath
      : undefined;
  return {
    config: materialized.config,
    insertedPaths: [...workspacePin.insertedPaths, ...materialized.insertedPaths],
    ownerAgentId,
    ...(pluginPath ? { pluginPath } : {}),
  };
}
