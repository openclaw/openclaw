import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AgentDeletionJournalAuthority } from "./agent-deletion-journal.types.js";
import { withAgentProvenancePublication } from "./agent-provenance-publication.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { createStateDomainPublication } from "./state-domain-publication.js";

export const agentDeletionJournalPublication =
  createStateDomainPublication<AgentDeletionJournalAuthority>({
    domain: "agent-deletion-journal",
    keyOf: (row) => row.agentId,
    isValue: (value): value is AgentDeletionJournalAuthority =>
      isRecord(value) &&
      typeof value.agentId === "string" &&
      typeof value.operationId === "string" &&
      typeof value.cleanupCompleted === "boolean",
  });

/** Observe the owning journal's commits; a read reply cannot overwrite a newer receipt. */
export function observeAgentDeletionJournal(agentId: string, context: OpenClawStateWorkerContext) {
  const id = normalizeAgentId(agentId);
  let observed = false;
  let known = false;
  let current: AgentDeletionJournalAuthority | undefined;
  const release = agentDeletionJournalPublication.subscribeFacts((change) => {
    if (
      change.kind === "committed" &&
      change.receipt.source.identity === context.admission.identity.key
    ) {
      const fact = change.receipt.facts.get(id);
      if (!fact || fact.kind === "unchanged") {
        return;
      }
      observed = true;
      known = fact.kind !== "unknown";
      current = fact.kind === "postimage" ? fact.value : undefined;
    } else if (change.kind === "unknown" && change.identity === context.admission.identity.key) {
      observed = true;
      known = false;
    }
  });
  return {
    release,
    seed(entry: AgentDeletionJournalAuthority | undefined) {
      if (!observed) {
        current = entry && {
          agentId: entry.agentId,
          operationId: entry.operationId,
          cleanupCompleted: entry.cleanupCompleted,
        };
        known = true;
      }
    },
    assertCurrent(operationId: string): void {
      context.admission.assertCurrent();
      if (!known || !current || current.operationId !== operationId || current.cleanupCompleted) {
        throw new Error(`Agent ${id} deletion no longer owns database cleanup.`);
      }
    },
  };
}

/** Journal writes share their existing lease admission and committed receipt delivery. */
export function withAgentDeletionJournalPublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const owner = withAgentProvenancePublication(createAdmission, context)(operation);
    const publication = agentDeletionJournalPublication.begin({
      identity: context.admission.identity.key,
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    });
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      if (isRecord(facts) && facts.journalAuthority !== undefined) {
        publication.committed(facts.journalAuthority);
      }
    });
    const finish = owner.admission.finish.bind(owner.admission);
    owner.admission.finish = () => {
      try {
        finish();
      } finally {
        const settlement = owner.admission.settlement;
        publication.finish(settlement?.kind === "completed", true);
      }
    };
    return owner;
  };
}
