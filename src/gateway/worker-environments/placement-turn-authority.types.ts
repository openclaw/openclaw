import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { WorkerSessionPlacementReadResult } from "./placement-read-projection.types.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionTurnClaim,
  WorkerSessionTurnClaimFacts,
} from "./placement-record.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";

export type PlacementTurnClaimAuthority = {
  readonly claim: WorkerSessionTurnClaim;
  readonly identity: Readonly<{ agentId: string; sessionKey: string }>;
  isCurrent: () => boolean;
  onRevoked: (listener: () => void) => () => void;
  release: () => void;
};

export type ClaimChange = {
  sessionId: string;
  sequence?: number;
  indeterminate?: true;
} & (
  | {
      kind: "claim";
      localOnly?: boolean;
      facts?: WorkerSessionTurnClaimFacts;
      workspaceResult?: WorkspaceResultPostimage;
      workspacePlacement?: WorkerSessionPlacementRecord;
      projection?: WorkerSessionPlacementReadResult;
      retired?: true;
    }
  | { kind: "workspace-result"; facts?: WorkspaceResultPostimage; cleared?: true }
  | { kind: "journal"; present?: boolean; uncertain?: true }
  | { kind: "tools"; claimId: string; authority?: ToolAuthority }
);
export type WorkspaceResultPostimage = {
  placement: WorkerSessionPlacementRecord;
  pendingResult: WorkerWorkspacePendingResult | undefined;
};
export type WorkspaceResultFacts = WorkspaceResultPostimage & {
  pendingResult: WorkerWorkspacePendingResult;
};
type ToolAuthority = { claim: WorkerSessionTurnClaim; toolNames: readonly string[] };
export type RetainedClaim = {
  claim: WorkerSessionTurnClaim;
  facts?: WorkerSessionTurnClaimFacts;
  createdSequence: number;
  publicationSequence: number;
  revoked: boolean;
  released: boolean;
  listeners: Set<() => void>;
};
export type RetainedPlacement = {
  placement: WorkerSessionPlacementRecord | undefined;
  sequence: number;
  revoked: boolean;
};
export type PlacementAuthorityOwner = {
  identity: DatabasePathIdentity;
  incarnation: string;
  active: boolean;
  claims: Map<string, Set<RetainedClaim>>;
  observations: Map<string | undefined, Set<{ revoked: boolean; indeterminate: boolean }>>;
  placementReaders: Map<string, Set<RetainedPlacement>>;
  pending: Set<ClaimChange>;
  settlementListeners: Set<() => void>;
  sequence: number;
  published: Map<string, number>;
  tools: Map<string, { sequence: number; authority?: ToolAuthority }>;
  workspaceResults: Map<string, WorkspaceResultFacts>;
  projections: Map<string, WorkerSessionPlacementReadResult>;
  preservation?: WorkerSessionPlacementRecord[];
};
