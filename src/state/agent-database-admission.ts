import { AsyncLocalStorage } from "node:async_hooks";
import {
  listAgentIds,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatAgentDatabaseOwnershipRepairHint } from "../infra/state-migrations.agent-owner-guidance.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

export type AgentDatabaseAdmissionRefusal = {
  agentId: string;
  paths: string[];
  reason: string;
  repairHint: string;
} & (
  | { code: "agent-database-ownership-mismatch"; embeddedOwnerId: string }
  | {
      code: "agent-database-inspection-pending" | "agent-database-inspection-failed";
      embeddedOwnerId?: undefined;
    }
);

type AdmissionOptions = { env?: NodeJS.ProcessEnv };

const refusalsByState = new Map<
  string,
  {
    source: "startup" | "diagnostic";
    refusals: ReadonlyMap<string, AgentDatabaseAdmissionRefusal>;
  }
>();

const preparation = new AsyncLocalStorage<{
  refusal: AgentDatabaseAdmissionRefusal;
  key: string;
  active: boolean;
  assertCurrent: () => void;
}>();

export function createAgentDatabaseInspectionRefusal(params: {
  agentId: string;
  paths: string[];
  reason: string;
  pending?: boolean;
}): AgentDatabaseAdmissionRefusal {
  return {
    agentId: params.agentId,
    paths: params.paths,
    code: params.pending ? "agent-database-inspection-pending" : "agent-database-inspection-failed",
    reason: params.reason,
    repairHint: params.pending
      ? 'Sessions remain unavailable until background inspection and preparation finish. If they cannot complete, stop the Gateway, run "openclaw doctor --fix", and restart.'
      : 'Sessions remain unavailable. Stop the Gateway, run "openclaw doctor --fix" to inspect and repair this agent database, and restart.',
  };
}

function stateKey(options: AdmissionOptions): string {
  return resolveOpenClawStateSqlitePath(options.env ?? process.env);
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
    if (previous === refusal) {
      continue;
    }
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
  const key = stateKey(options);
  const refusal = refusalsByState.get(key)?.refusals.get(normalizeAgentId(agentId));
  const scope = preparation.getStore();
  if (scope && scope.key === key && scope.refusal.agentId === normalizeAgentId(agentId)) {
    if (!scope.active) {
      throw new Error(`Agent database preparation has ended: ${agentId}`);
    }
    scope.assertCurrent();
    if (scope.refusal === refusal) {
      return undefined;
    }
  }
  return refusal;
}

/** Preparation borrows only its own pending admission; public callers remain refused. */
export async function preparePendingAgentDatabase(
  refusal: AgentDatabaseAdmissionRefusal,
  options: AdmissionOptions & { assertCurrent: () => void },
  run: () => Promise<void>,
): Promise<void> {
  const key = stateKey(options);
  const assertCurrent = () => {
    options.assertCurrent();
    if (
      refusal.code !== "agent-database-inspection-pending" ||
      refusalsByState.get(key)?.refusals.get(refusal.agentId) !== refusal
    ) {
      throw new Error(`Agent database admission changed during preparation: ${refusal.agentId}`);
    }
  };
  assertCurrent();
  const scope = { key, refusal, assertCurrent, active: true };
  try {
    await preparation.run(scope, run);
    scope.assertCurrent();
    const current = refusalsByState.get(key)!;
    const refusals = new Map(current.refusals);
    refusals.delete(refusal.agentId);
    refusalsByState.set(key, { ...current, refusals });
  } finally {
    scope.active = false;
  }
  sessionChanges.emit({ all: true, scope: "stores" });
}

/** Runtime preparation adds its config-generation guard to the same admission borrow. */
export async function withAgentDatabasePreparationGuard<T>(
  assertCurrent: () => void,
  run: () => Promise<T>,
): Promise<T> {
  const parent = preparation.getStore();
  if (!parent?.active) {
    throw new Error("No pending agent database preparation owns this operation");
  }
  const original = parent.assertCurrent;
  parent.assertCurrent = () => {
    original();
    assertCurrent();
  };
  const scope = {
    ...parent,
    assertCurrent: () => {
      if (!parent.active) {
        throw new Error("Agent database preparation has ended");
      }
      parent.assertCurrent();
    },
  };
  try {
    scope.assertCurrent();
    return await preparation.run(scope, run);
  } finally {
    scope.active = false;
  }
}

export function failPendingAgentDatabase(
  refusal: AgentDatabaseAdmissionRefusal,
  reason: string,
  options: AdmissionOptions,
): void {
  const key = stateKey(options);
  const current = refusalsByState.get(key);
  if (current?.refusals.get(refusal.agentId) !== refusal) {
    return;
  }
  const refusals = new Map(current.refusals);
  refusals.set(refusal.agentId, createAgentDatabaseInspectionRefusal({ ...refusal, reason }));
  refusalsByState.set(key, { ...current, refusals });
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
  const env = options.env ?? process.env;
  const result = await preflightOpenClawDatabaseSchemas({
    env,
    configuredAgentDatabaseTargets: [],
    configuredAgentDatabaseCandidatePaths: resolveConfiguredAgentDatabaseCandidatePaths(config, {
      env,
    }),
    agentAdmissionConfig: config,
  });
  return result.agentRefusals ?? [];
}
