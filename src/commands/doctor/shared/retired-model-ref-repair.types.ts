import type { SessionEntry } from "../../../config/sessions/types.js";

// Shared contracts for Doctor's retired-model repair owner. Kept in a leaf
// module so sibling repair helpers can share them without import cycles.
export type ModelRetirementScope = "route" | "owner" | "provider";

export type ModelRefRepair =
  | { kind: "unchanged" }
  | { kind: "replace"; modelRef: string; reason: "reference-preservation" }
  | {
      kind: "replace";
      modelRef: string;
      reason: "retirement";
      retirementScope: ModelRetirementScope;
    }
  | { kind: "clear"; provider: string; modelRef: string; retirementScope: ModelRetirementScope };
export type ModelRefRepairResolver = (params: {
  modelRef: string;
  agentId?: string;
  authProfileId?: string;
  authProfileSource?: SessionEntry["authProfileOverrideSource"];
  authProfileOnly?: boolean;
}) => ModelRefRepair;

export type SessionModelRetirement = {
  agentId: string;
  resolve: ModelRefRepairResolver;
  defaultModelRef?: string;
  warnings: string[];
};
