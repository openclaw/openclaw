import { AsyncLocalStorage } from "node:async_hooks";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
import {
  listAgentIds,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatAgentDatabaseOwnershipRepairHint } from "../infra/state-migrations.agent-owner-guidance.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import {
  openClawStateDatabaseCache,
  requireOpenClawStateDatabaseIdentity,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
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

export function createAgentDatabaseAdmissionErrorShape(
  refusal: AgentDatabaseAdmissionRefusal,
): ErrorShape {
  const retryable = refusal.code === "agent-database-inspection-pending";
  return {
    code: "UNAVAILABLE",
    message: `${refusal.reason}\n${refusal.repairHint}`,
    details: refusal,
    retryable,
    ...(retryable ? { retryAfterMs: 250 } : {}),
  };
}

// Refusals are public protocol objects. Keep inspection causes private to the admission owner.
const refusalCauses = new WeakMap<AgentDatabaseAdmissionRefusal, unknown>();

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
  completion: Promise<void>;
}>();

export function createAgentDatabaseInspectionRefusal(params: {
  agentId: string;
  paths: string[];
  reason: string;
  pending?: boolean;
  cause?: unknown;
}): AgentDatabaseAdmissionRefusal {
  const refusal: AgentDatabaseAdmissionRefusal = {
    agentId: params.agentId,
    paths: params.paths,
    code: params.pending ? "agent-database-inspection-pending" : "agent-database-inspection-failed",
    reason: params.reason,
    repairHint: params.pending
      ? 'Sessions remain unavailable until background inspection and preparation finish. If they cannot complete, stop the Gateway, run "openclaw doctor --fix", and restart.'
      : 'Sessions remain unavailable. Stop the Gateway, run "openclaw doctor --fix" to inspect and repair this agent database, and restart.',
  };
  refusalCauses.set(refusal, params.cause);
  return refusal;
}

function stateKey(options: AdmissionOptions): string {
  return resolveOpenClawStateSqlitePath(options.env ?? process.env);
}

function sameKnownState(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftIdentity = openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(left);
  const rightIdentity = openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity.key === rightIdentity.key);
}

/** Capture existing pending decisions; a later commit must never revoke their successors. */
export function captureAgentDatabasePreparationDeletion(
  agentId: string,
  database: Pick<OpenClawStateDatabase, "db" | "path">,
): () => void {
  return captureAgentDatabasePreparationDeletionForIdentity(agentId, {
    identityKey: requireOpenClawStateDatabaseIdentity(database).key,
    databasePath: database.path,
  });
}

export function captureAgentDatabasePreparationDeletionForIdentity(
  agentId: string,
  { identityKey, databasePath }: { identityKey: string; databasePath: string },
): () => void {
  const id = normalizeAgentId(agentId);
  const captured = [...refusalsByState].flatMap(([key, owner]) => {
    const known = openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(key);
    const refusal = owner.refusals.get(id);
    return (key === databasePath || known?.key === identityKey) &&
      refusal?.code === "agent-database-inspection-pending"
      ? [{ key, owner, refusal }]
      : [];
  });
  return () => {
    if (
      openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(databasePath)?.key !==
      identityKey
    ) {
      return;
    }
    for (const { key, owner, refusal } of captured) {
      if (
        refusalsByState.get(key) !== owner ||
        owner.refusals.get(id) !== refusal ||
        !sameKnownState(key, databasePath)
      ) {
        continue;
      }
      const refusals = new Map(owner.refusals);
      refusals.set(
        id,
        createAgentDatabaseInspectionRefusal({
          ...refusal,
          reason: `Agent ${id} was deleted during startup inspection`,
        }),
      );
      owner.refusals = refusals;
    }
  };
}

/** Capture only the live preparation whose native command must report fresh journal facts. */
export function captureAgentDatabasePreparationJournal(
  agentId: string,
  options: AdmissionOptions = {},
): ((present: unknown) => void) | undefined {
  const scope = preparation.getStore();
  if (
    !scope ||
    scope.refusal.agentId !== normalizeAgentId(agentId) ||
    !sameKnownState(scope.key, stateKey(options))
  ) {
    return undefined;
  }
  const assertCurrent = () => {
    if (!scope.active) {
      throw new Error(`Agent database preparation has ended: ${agentId}`);
    }
    scope.assertCurrent();
  };
  assertCurrent();
  return (present) => {
    assertCurrent();
    if (present !== false) {
      throw new Error(`Agent ${scope.refusal.agentId} was deleted during startup inspection`);
    }
  };
}

/** Background work joins its creating admission without retaining the temporary write borrow. */
export function captureAgentDatabasePreparationCompletion(
  agentId: string,
  options: AdmissionOptions = {},
): Promise<void> | undefined {
  const scope = preparation.getStore();
  return scope?.active &&
    scope.refusal.agentId === normalizeAgentId(agentId) &&
    sameKnownState(scope.key, stateKey(options))
    ? scope.completion
    : undefined;
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
    const merged = previous
      ? {
          ...previous,
          paths: [...new Set([...previous.paths, ...refusal.paths])],
          reason: `${previous.reason}\n${refusal.reason}`,
          repairHint: `${previous.repairHint}\n${refusal.repairHint}`,
        }
      : refusal;
    if (previous) {
      refusalCauses.set(
        merged,
        new AggregateError([
          new AgentDatabaseAdmissionError(previous),
          new AgentDatabaseAdmissionError(refusal),
        ]),
      );
    }
    byAgent.set(refusal.agentId, merged);
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
  return readSelectedAgentDatabaseAdmissionRefusal(
    stateKey(options),
    normalizeAgentId(agentId),
    agentId,
  );
}

function readSelectedAgentDatabaseAdmissionRefusal(
  key: string,
  agentId: string,
  requestedAgentId: string,
): AgentDatabaseAdmissionRefusal | undefined {
  const refusal = refusalsByState.get(key)?.refusals.get(agentId);
  const scope = preparation.getStore();
  if (scope && scope.key === key && scope.refusal.agentId === agentId) {
    if (!scope.active) {
      throw new Error(`Agent database preparation has ended: ${requestedAgentId}`);
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
  const completion = createDeferredCore();
  // Preparation can fail without a background consumer.
  void completion.promise.catch(() => {});
  const scope = { key, refusal, assertCurrent, active: true, completion: completion.promise };
  try {
    await preparation.run(scope, run);
    scope.assertCurrent();
    const current = refusalsByState.get(key)!;
    const refusals = new Map(current.refusals);
    refusals.delete(refusal.agentId);
    current.refusals = refusals;
    completion.resolve();
  } catch (error) {
    completion.reject(error);
    throw error;
  } finally {
    scope.active = false;
  }
  sessionChanges.emit({ all: true, scope: { agentId: refusal.agentId, topology: true } });
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
  cause: unknown,
  options: AdmissionOptions,
): void {
  const key = stateKey(options);
  const current = refusalsByState.get(key);
  if (current?.refusals.get(refusal.agentId) !== refusal) {
    return;
  }
  const refusals = new Map(current.refusals);
  refusals.set(
    refusal.agentId,
    createAgentDatabaseInspectionRefusal({ ...refusal, reason: formatErrorMessage(cause), cause }),
  );
  current.refusals = refusals;
}

export function listAgentDatabaseAdmissionRefusals(
  options: AdmissionOptions = {},
): AgentDatabaseAdmissionRefusal[] {
  return [...(refusalsByState.get(stateKey(options))?.refusals.values() ?? [])];
}

export class AgentDatabaseAdmissionError extends Error {
  constructor(readonly refusal: AgentDatabaseAdmissionRefusal) {
    super(
      `Agent ${refusal.agentId} (${refusal.paths.join(", ")}): ${refusal.reason}\n${refusal.repairHint}`,
      { cause: refusalCauses.get(refusal) },
    );
    this.name = "AgentDatabaseAdmissionError";
  }
}

/** A proven owner mismatch needs operator action; unavailable inspections prove no mismatch. */
export function isAgentDatabaseOwnershipMismatchError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) =>
      candidate instanceof AgentDatabaseAdmissionError &&
      candidate.refusal.code === "agent-database-ownership-mismatch",
  );
}

export function assertAgentDatabaseAdmitted(agentId: string, options: AdmissionOptions = {}): void {
  const refusal = readAgentDatabaseAdmissionRefusal(agentId, options);
  if (refusal) {
    throw new AgentDatabaseAdmissionError(refusal);
  }
}

/** Capture only the selector; refusal decisions and the caller's preparation remain live. */
export function captureAgentDatabaseAdmission(
  agentId: string,
  options: AdmissionOptions = {},
): () => void {
  const key = stateKey(options);
  const normalizedAgentId = normalizeAgentId(agentId);
  return () => {
    const refusal = readSelectedAgentDatabaseAdmissionRefusal(key, normalizedAgentId, agentId);
    if (refusal) {
      throw new AgentDatabaseAdmissionError(refusal);
    }
  };
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
