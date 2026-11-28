import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import { agentProvenancePublication } from "./agent-provenance-publication.js";
import { recordAgentProvenanceInDatabase } from "./agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import type { AgentProvenance } from "./agent-provenance.types.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "./worker-operation-registry.js";

export const agentProvenanceOperations = {
  "agentProvenance.record": (input: AgentProvenance, context) => {
    ensureAgentProvenanceSchema({ database: context.open(), ...context.stateOptions() });
    return context.write(
      ({ db }) => {
        const { receipt } = agentProvenancePublication.capture(db, () =>
          recordAgentProvenanceInDatabase(db, input),
        );
        deferSqliteWorkerCommitReceipt(db, {
          provenanceAuthority: agentProvenancePublication.bound(receipt),
        });
      },
      { operationLabel: "agent-provenance.record" },
    );
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
