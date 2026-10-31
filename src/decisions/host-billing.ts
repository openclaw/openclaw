import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";

/** Prepared route facts owned by the host, never portable provider result data. */
export type PreparedDecisionBillingFacts = {
  provider: string;
  model: string;
  billing?: ModelDecisionCapabilities["billing"];
};
