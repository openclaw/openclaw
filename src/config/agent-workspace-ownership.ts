import path from "node:path";
import {
  listAgentEntries,
  resolveAgentWorkspaceDir,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type AgentWorkspaceOwnershipPin = {
  config: OpenClawConfig;
  workspace?: string;
  pluginPath?: string;
  insertedPaths: string[][];
};

/** Pins a sole agent's resolved workspace before a write expands the roster. */
export function pinSoleAgentWorkspaceForFleetExpansion(params: {
  sourceConfig: OpenClawConfig;
  targetConfig: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): AgentWorkspaceOwnershipPin {
  const agentId = normalizeAgentId(params.agentId);
  const targetAgents = params.targetConfig.agents ?? {};
  const { list: _legacyList, ...canonicalTargetAgents } = targetAgents;
  const entries = targetAgents.entries
    ? { ...targetAgents.entries }
    : toAgentEntriesRecord(listAgentEntries(params.targetConfig));
  const entryKey = Object.keys(entries).find(
    (candidate) => normalizeAgentId(candidate) === agentId,
  );
  const entry = entryKey ? entries[entryKey] : undefined;
  const workspaceIsResolved =
    typeof entry?.workspace === "string" && entry.workspace.trim().length > 0;
  const workspaceIsMalformed =
    entry !== undefined &&
    Object.hasOwn(entry, "workspace") &&
    entry.workspace !== undefined &&
    typeof entry.workspace !== "string";
  if (!entry || workspaceIsMalformed) {
    return { config: params.targetConfig, insertedPaths: [] };
  }

  // Resolve against the old sole-agent topology. Resolving after the roster
  // expands would silently select the new per-agent workspace instead.
  const workspace = resolveAgentWorkspaceDir(params.sourceConfig, agentId, params.env);
  if (workspaceIsResolved) {
    const targetWorkspace = resolveAgentWorkspaceDir(params.targetConfig, agentId, params.env);
    if (targetWorkspace !== workspace) {
      return { config: params.targetConfig, insertedPaths: [] };
    }
  } else {
    entries[entryKey!] = { ...entry, workspace };
  }
  const pluginPath = path.join(workspace, ".openclaw", "extensions");
  const rawPlugins = params.targetConfig.plugins as unknown;
  const rawPluginLoad = isRecord(rawPlugins) ? rawPlugins.load : undefined;
  const rawPluginPaths = isRecord(rawPluginLoad) ? rawPluginLoad.paths : undefined;
  const pluginPaths = Array.isArray(rawPluginPaths) ? rawPluginPaths : [];
  const preservePluginPath =
    (rawPlugins === undefined || isRecord(rawPlugins)) &&
    (rawPluginLoad === undefined || isRecord(rawPluginLoad)) &&
    (rawPluginPaths === undefined || Array.isArray(rawPluginPaths));
  return {
    config: {
      ...params.targetConfig,
      agents: {
        ...canonicalTargetAgents,
        entries,
      },
      ...(preservePluginPath
        ? {
            plugins: {
              ...params.targetConfig.plugins,
              load: {
                ...params.targetConfig.plugins?.load,
                paths: pluginPaths.includes(pluginPath)
                  ? pluginPaths
                  : [...pluginPaths, pluginPath],
              },
            },
          }
        : {}),
    },
    workspace,
    // The path may already have been projected into the runtime config. It is
    // still write-managed here and must exist before plugin validation runs.
    ...(preservePluginPath ? { pluginPath } : {}),
    insertedPaths: [
      ...(workspaceIsResolved ? [] : [["agents", "entries", entryKey!, "workspace"]]),
      ...(preservePluginPath && !pluginPaths.includes(pluginPath)
        ? [["plugins", "load", "paths"]]
        : []),
    ],
  };
}
