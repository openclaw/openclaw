import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";

export const ensureAgentProvenanceSchema = createOpenClawStateSchemaEnsurer({
  table: "agent_provenance",
  operationLabel: "agent-provenance.schema.ensure",
});
