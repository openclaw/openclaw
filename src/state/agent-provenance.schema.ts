import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema-ensure.js";

export const ensureAgentProvenanceSchema = createOpenClawStateSchemaEnsurer({
  table: "agent_provenance",
  operationLabel: "agent-provenance.schema.ensure",
});
