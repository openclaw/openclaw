import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";

export type SessionDatabaseSelectionOptions = {
  agent?: string;
  allAgents?: boolean;
};

export type SessionDatabaseTarget = {
  agentId: string;
  databasePath: string;
};

const NON_FATAL_DATABASE_DISCOVERY_ERROR_CODES = new Set(["EACCES", "ENOENT", "ENOTDIR", "EPERM"]);

function resolveSessionDatabaseTarget(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  databasePath?: string;
}): SessionDatabaseTarget {
  const agentId = normalizeAgentId(params.agentId);
  return {
    agentId,
    databasePath:
      params.databasePath ?? resolveOpenClawAgentSqlitePath({ agentId, env: params.env }),
  };
}

function dedupeTargetsByAgentId(targets: SessionDatabaseTarget[]): SessionDatabaseTarget[] {
  const deduped = new Map<string, SessionDatabaseTarget>();
  for (const target of targets) {
    if (!deduped.has(target.agentId)) {
      deduped.set(target.agentId, target);
    }
  }
  return [...deduped.values()];
}

function shouldSkipDatabaseDiscoveryError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && NON_FATAL_DATABASE_DISCOVERY_ERROR_CODES.has(code);
}

function configuredAgentTargets(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): SessionDatabaseTarget[] {
  return listAgentIds(cfg).map((agentId) => resolveSessionDatabaseTarget({ agentId, env }));
}

function resolveRegisteredAgentDatabaseTargets(env: NodeJS.ProcessEnv): SessionDatabaseTarget[] {
  try {
    return listOpenClawRegisteredAgentDatabases({ env }).flatMap((row) => {
      const agentId = normalizeAgentId(row.agentId);
      return [
        resolveSessionDatabaseTarget({
          agentId,
          env,
          databasePath: row.path,
        }),
      ];
    });
  } catch (err) {
    if (shouldSkipDatabaseDiscoveryError(err)) {
      return [];
    }
    throw err;
  }
}

export function resolveAllAgentSessionDatabaseTargetsSync(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionDatabaseTarget[] {
  const env = params.env ?? process.env;
  return dedupeTargetsByAgentId([
    ...configuredAgentTargets(cfg, env),
    ...resolveRegisteredAgentDatabaseTargets(env),
  ]);
}

export function resolveAgentSessionDatabaseTargetsSync(
  cfg: OpenClawConfig,
  agentId: string,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionDatabaseTarget[] {
  const env = params.env ?? process.env;
  const requested = normalizeAgentId(agentId);
  const configured = [resolveSessionDatabaseTarget({ agentId: requested, env })];
  const registered = resolveRegisteredAgentDatabaseTargets(env).filter(
    (target) => normalizeAgentId(target.agentId) === requested,
  );
  return dedupeTargetsByAgentId([...configured, ...registered]);
}

export async function resolveAllAgentSessionDatabaseTargets(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): Promise<SessionDatabaseTarget[]> {
  return resolveAllAgentSessionDatabaseTargetsSync(cfg, params);
}

export function resolveSessionDatabaseTargets(
  cfg: OpenClawConfig,
  opts: SessionDatabaseSelectionOptions,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionDatabaseTarget[] {
  const env = params.env ?? process.env;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const hasAgent = Boolean(opts.agent?.trim());
  const allAgents = opts.allAgents === true;
  if (hasAgent && allAgents) {
    throw new Error("--agent and --all-agents cannot be used together");
  }

  if (allAgents) {
    return resolveAllAgentSessionDatabaseTargetsSync(cfg, { env });
  }

  if (hasAgent) {
    const knownAgents = listAgentIds(cfg);
    const requested = normalizeAgentId(opts.agent ?? "");
    if (!knownAgents.includes(requested)) {
      throw new Error(
        `Unknown agent id "${opts.agent}". Use "openclaw agents list" to see configured agents.`,
      );
    }
    return [resolveSessionDatabaseTarget({ agentId: requested, env })];
  }

  return [resolveSessionDatabaseTarget({ agentId: defaultAgentId, env })];
}
