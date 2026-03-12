import path from "node:path";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  resolveAgentSessionDirsFromAgentsDir,
  resolveAgentSessionDirsFromAgentsDirSync,
} from "../../agents/session-dirs.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveStorePath } from "./paths.js";

export type SessionStoreSelectionOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
};

export type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

function dedupeTargetsByStorePath(targets: SessionStoreTarget[]): SessionStoreTarget[] {
  const deduped = new Map<string, SessionStoreTarget>();
  for (const target of targets) {
    if (!deduped.has(target.storePath)) {
      deduped.set(target.storePath, target);
    }
  }
  return [...deduped.values()];
}

function resolveSessionStoreDiscoveryState(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): {
  configuredTargets: SessionStoreTarget[];
  agentsRoots: string[];
} {
  const configuredTargets = resolveSessionStoreTargets(cfg, { allAgents: true }, { env });
  const agentsRoots = new Set<string>();
  for (const target of configuredTargets) {
    const agentsDir = resolveAgentsDirFromSessionStorePath(target.storePath);
    if (agentsDir) {
      agentsRoots.add(agentsDir);
    }
  }
  agentsRoots.add(path.join(resolveStateDir(env), "agents"));
  return {
    configuredTargets,
    agentsRoots: [...agentsRoots],
  };
}

function toDiscoveredSessionStoreTargets(sessionsDirs: string[]): SessionStoreTarget[] {
  return sessionsDirs.map((sessionsDir) => {
    const agentId = normalizeAgentId(path.basename(path.dirname(sessionsDir)));
    return {
      agentId,
      // Keep the actual on-disk store path so retired/manual agent dirs remain discoverable
      // even if their directory name no longer round-trips through normalizeAgentId().
      storePath: path.join(sessionsDir, "sessions.json"),
    };
  });
}

export function resolveAllAgentSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
  const discoveredTargets = toDiscoveredSessionStoreTargets(
    agentsRoots.flatMap((agentsDir) => resolveAgentSessionDirsFromAgentsDirSync(agentsDir)),
  );
  return dedupeTargetsByStorePath([...configuredTargets, ...discoveredTargets]);
}

export async function resolveAllAgentSessionStoreTargets(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): Promise<SessionStoreTarget[]> {
  const env = params.env ?? process.env;
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);

  const discoveredDirs = await Promise.all(
    agentsRoots.map((agentsDir) => resolveAgentSessionDirsFromAgentsDir(agentsDir)),
  );
  const discoveredTargets = toDiscoveredSessionStoreTargets(discoveredDirs.flat());
  return dedupeTargetsByStorePath([...configuredTargets, ...discoveredTargets]);
}

export function resolveSessionStoreTargets(
  cfg: OpenClawConfig,
  opts: SessionStoreSelectionOptions,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const hasAgent = Boolean(opts.agent?.trim());
  const allAgents = opts.allAgents === true;
  if (hasAgent && allAgents) {
    throw new Error("--agent and --all-agents cannot be used together");
  }
  if (opts.store && (hasAgent || allAgents)) {
    throw new Error("--store cannot be combined with --agent or --all-agents");
  }

  if (opts.store) {
    return [
      {
        agentId: defaultAgentId,
        storePath: resolveStorePath(opts.store, { agentId: defaultAgentId, env }),
      },
    ];
  }

  if (allAgents) {
    const targets = listAgentIds(cfg).map((agentId) => ({
      agentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId, env }),
    }));
    return dedupeTargetsByStorePath(targets);
  }

  if (hasAgent) {
    const knownAgents = listAgentIds(cfg);
    const requested = normalizeAgentId(opts.agent ?? "");
    if (!knownAgents.includes(requested)) {
      throw new Error(
        `Unknown agent id "${opts.agent}". Use "openclaw agents list" to see configured agents.`,
      );
    }
    return [
      {
        agentId: requested,
        storePath: resolveStorePath(cfg.session?.store, { agentId: requested, env }),
      },
    ];
  }

  return [
    {
      agentId: defaultAgentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId: defaultAgentId, env }),
    },
  ];
}
