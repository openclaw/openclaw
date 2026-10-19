import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import type { OpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution-contract.js";
import type { HeartbeatOutcomeRow } from "./heartbeat-outcome-store.kernel.js";

const MAX_STORES = 32;
const MAX_OUTCOMES = 128;
type OutcomeFacts = {
  agentId: string;
  rows: Map<string, HeartbeatOutcomeRow | null>;
  release(): void;
};
const stores = new Map<object, OutcomeFacts>();

sessionChanges.subscribeFacts((change) => {
  if (!sessionChangeScopeAffectsStoredRows(change)) {
    return;
  }
  if ("all" in change) {
    const agentId = typeof change.scope === "object" ? change.scope.agentId : undefined;
    for (const facts of stores.values()) {
      if (!agentId || facts.agentId === agentId) {
        facts.rows.clear();
      }
    }
    return;
  }
  const changed = change.facts;
  if (
    !change.factsInvalidated &&
    changed?.kind !== "removed" &&
    !((changed?.kind === "entry" || changed?.kind === "replacement") && changed.lifecycleChanged)
  ) {
    return;
  }
  for (const facts of stores.values()) {
    if (!change.agentId || facts.agentId === change.agentId) {
      facts.rows.delete(change.sessionKey);
    }
  }
});

/** Facts borrow the executor's existing physical lifetime; they confer no run authority. */
export function heartbeatOutcomeFacts(execution: OpenClawAgentDatabaseExecution) {
  const identity = execution.fileIdentity;
  if (!identity) {
    return undefined;
  }
  let facts = stores.get(identity);
  if (!facts) {
    facts = {
      agentId: execution.agentId,
      rows: new Map(),
      release: execution.onTerminal(() => stores.delete(identity)),
    };
    stores.set(identity, facts);
    if (stores.size > MAX_STORES) {
      const oldest = stores.entries().next().value!;
      oldest[1].release();
      stores.delete(oldest[0]);
    }
  }
  return facts.rows;
}

export function recordHeartbeatOutcomeFact(
  execution: OpenClawAgentDatabaseExecution,
  sessionKey: string,
  row: HeartbeatOutcomeRow | undefined,
): void {
  const rows = heartbeatOutcomeFacts(execution);
  if (!rows) {
    return;
  }
  rows.delete(sessionKey);
  rows.set(sessionKey, row ?? null);
  if (rows.size > MAX_OUTCOMES) {
    rows.delete(rows.keys().next().value!);
  }
}
