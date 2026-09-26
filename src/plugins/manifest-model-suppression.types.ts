/** Compiled manifest policy for one exact metadata snapshot and config object. */
import type { ModelApi } from "../config/types.models.js";

export type ManifestModelSuppressionResolver = {
  (input: {
    provider?: string | null;
    id?: string | null;
    baseUrl?: string | null;
    api?: ModelApi;
    unconditionalOnly?: boolean;
  }): { suppress: true; errorMessage: string; retirement?: { replacedBy?: string } } | undefined;
  hasRetirementCandidate(input: { provider?: string | null; id?: string | null }): boolean;
};
