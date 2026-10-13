import type {
  SessionActorPendingFinalDelivery,
  SessionActorPhaseInputs,
  SessionActorReducer,
} from "../../config/sessions/session-actor-contract.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";

export type AgentTurnRestartClaimCleanup = {
  operation: NonNullable<SessionActorPhaseInputs["completeTurn"]["restartClaimCleanup"]>;
  committed(): void;
};

export type AgentTurnCompletion = {
  /** The retained completion owner must still own its source before a transcript write. */
  assertCurrent(): SessionEntry | undefined;
  current(): SessionEntry;
  refresh(): Promise<SessionEntry>;
  patch(
    reducer: SessionActorReducer | ((entry: SessionEntry) => SessionActorReducer | undefined),
  ): void;
  complete(pendingFinalDelivery?: SessionActorPendingFinalDelivery): Promise<SessionEntry>;
};
