import path from "node:path";
import {
  listAgentIds,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatAgentDatabaseOwnershipRepairHint } from "../infra/state-migrations.agent-owner-guidance.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

export type AgentDatabaseAdmissionRefusal = {
  agentId: string;
  paths: string[];
  embeddedOwnerId: string;
  code: "agent-database-ownership-mismatch";
  reason: string;
  repairHint: string;
};

type AdmissionOptions = { env?: NodeJS.ProcessEnv };

const refusalsByState = new Map<
  string,
  {
    source: "startup" | "diagnostic";
    refusals: ReadonlyMap<string, AgentDatabaseAdmissionRefusal>;
  }
>();

function stateKey(options: AdmissionOptions): string {
  return path.resolve(resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

/** Ownership is derived from the inspected file; missing or corrupt metadata keeps normal refusal. */
export function inspectAgentDatabaseAdmission(params: {
  agentId: string;
  path: string;
  metadata: { role: string | null; agentId: string | null } | null;
}): AgentDatabaseAdmissionRefusal | undefined {
  const agentId = normalizeAgentId(params.agentId);
  const owner = params.metadata;
  if (owner?.role !== "agent" || !owner.agentId || owner.agentId === agentId) {
    return undefined;
  }
  return {
    agentId,
    paths: [params.path],
    embeddedOwnerId: owner.agentId,
    code: "agent-database-ownership-mismatch",
    reason: `Refused agent ${agentId}: database ${params.path} belongs to agent ${owner.agentId}; requested agent ${agentId}.`,
    repairHint: formatAgentDatabaseOwnershipRepairHint(params.path),
  };
}

export function canIsolateAgentDatabase(config: OpenClawConfig, agentId: string): boolean {
  return (
    listAgentIds(config).includes(agentId) &&
    !isReservedSystemAgentId(agentId) &&
    agentId !== tryResolveAmbientOwnerAgentId(config) &&
    agentId !== tryResolveLegacyCompatibilityAgentId(config)
  );
}

/** Only a new admission pass replaces this boot's decisions; file edits never clear a live refusal. */
export function recordAgentDatabaseAdmissions(
  refusals: readonly AgentDatabaseAdmissionRefusal[],
  options: AdmissionOptions & { source?: "startup" | "diagnostic" } = {},
): void {
  const key = stateKey(options);
  const source = options.source ?? "diagnostic";
  if (source === "diagnostic" && refusalsByState.get(key)?.source === "startup") {
    return;
  }
  const byAgent = new Map<string, AgentDatabaseAdmissionRefusal>();
  for (const refusal of refusals) {
    const previous = byAgent.get(refusal.agentId);
    byAgent.set(
      refusal.agentId,
      previous
        ? {
            ...previous,
            paths: [...new Set([...previous.paths, ...refusal.paths])],
            reason: `${previous.reason}\n${refusal.reason}`,
            repairHint: `${previous.repairHint}\n${refusal.repairHint}`,
          }
        : refusal,
    );
  }
  refusalsByState.set(key, { source, refusals: byAgent });
}

export function hasAgentDatabaseAdmissions(options: AdmissionOptions = {}): boolean {
  return refusalsByState.has(stateKey(options));
}

export function readAgentDatabaseAdmissionRefusal(
  agentId: string,
  options: AdmissionOptions = {},
): AgentDatabaseAdmissionRefusal | undefined {
  return refusalsByState.get(stateKey(options))?.refusals.get(normalizeAgentId(agentId));
}

export function listAgentDatabaseAdmissionRefusals(
  options: AdmissionOptions = {},
): AgentDatabaseAdmissionRefusal[] {
  return [...(refusalsByState.get(stateKey(options))?.refusals.values() ?? [])];
}

export class AgentDatabaseAdmissionError extends Error {
  constructor(readonly refusal: AgentDatabaseAdmissionRefusal) {
    super(`${refusal.reason}\n${refusal.repairHint}`);
    this.name = "AgentDatabaseAdmissionError";
  }
}

export function assertAgentDatabaseAdmitted(agentId: string, options: AdmissionOptions = {}): void {
  const refusal = readAgentDatabaseAdmissionRefusal(agentId, options);
  if (refusal) {
    throw new AgentDatabaseAdmissionError(refusal);
  }
}

/** Standalone diagnostics derive the same facts without borrowing another process's decision. */
export async function evaluateAgentDatabaseAdmissions(
  config: OpenClawConfig,
  options: AdmissionOptions = {},
): Promise<AgentDatabaseAdmissionRefusal[]> {
  const { preflightOpenClawDatabaseSchemas } = await import("./openclaw-database-preflight.js");
  const { resolveConfiguredAgentDatabaseCandidatePaths } =
    await import("../config/sessions/targets.js");
  const { OPENCLAW_AGENT_SCHEMA_VERSION } = await import("./openclaw-agent-db-contract.js");
  const { OPENCLAW_STATE_SCHEMA_VERSION } = await import("./openclaw-state-db-contract.js");
  const env = options.env ?? process.env;
  const result = await preflightOpenClawDatabaseSchemas({
    env,
    supportedVersions: {
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    configuredAgentDatabaseTargets: [],
    configuredAgentDatabaseCandidatePaths: resolveConfiguredAgentDatabaseCandidatePaths(config, {
      env,
    }),
    agentAdmissionConfig: config,
  });
  return result.agentRefusals ?? [];
}
