import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import type { AgentProvenance } from "./agent-provenance.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { createStateDomainPublication } from "./state-domain-publication.js";

export const agentProvenancePublication = createStateDomainPublication<AgentProvenance>({
  domain: "agent-provenance",
  keyOf: (row) => row.agentId,
  isValue: (value): value is AgentProvenance =>
    isRecord(value) &&
    typeof value.agentId === "string" &&
    (value.createdVia === "operator" ||
      value.createdVia === "agent" ||
      value.createdVia === "claw") &&
    (value.creatorAgentId === null || typeof value.creatorAgentId === "string") &&
    typeof value.createdAtMs === "number",
});

export function withAgentProvenancePublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const owner = createAdmission(operation);
    const publication = agentProvenancePublication.begin({
      identity: context.admission.identity.key,
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    });
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      if (isRecord(facts) && facts.provenanceAuthority !== undefined) {
        publication.committed(facts.provenanceAuthority);
      }
    });
    const finish = owner.admission.finish.bind(owner.admission);
    owner.admission.finish = () => {
      try {
        finish();
      } finally {
        publication.finish(owner.admission.settlement?.kind === "completed", true);
      }
    };
    return owner;
  };
}
