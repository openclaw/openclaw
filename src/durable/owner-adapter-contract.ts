import type {
  WakeObligation,
  WakeObligationReason,
  WakeObligationTargetResolutionStatus,
} from "./types.js";

export type DurableOwnerAttentionFact = {
  sourceOwner: string;
  sourceRef: string;
  sourceRevision: string;
  reason: WakeObligationReason;
  targetKind: "agent_session" | "inspect_only";
  targetRef: string;
  targetResolutionStatus: WakeObligationTargetResolutionStatus;
  targetResolutionReason: string;
  ownerRef?: string;
  reportRouteRef?: string;
  requesterRunId?: string;
  dedupeKey: string;
  suspendedReason?: string;
  metadata: Record<string, unknown>;
};

export type DurableOwnerDispatchResult =
  | { kind: "acknowledged"; evidence: Record<string, unknown> }
  | { kind: "handoff_accepted"; evidence: Record<string, unknown> }
  | { kind: "deferred"; reason: string; evidence?: Record<string, unknown> }
  | { kind: "suspended"; reason: string; evidence?: Record<string, unknown> }
  | { kind: "superseded"; reason: string; evidence?: Record<string, unknown> };

export type DurableOwnerAdapter = {
  sourceOwner: string;
  inspect(sourceRef: string): DurableOwnerAttentionFact | undefined;
  listAttentionFacts(options?: { limit?: number; now?: number }): DurableOwnerAttentionFact[];
  dispatchAttention(params: {
    wake: WakeObligation;
    claimToken: string;
  }): Promise<DurableOwnerDispatchResult>;
};
