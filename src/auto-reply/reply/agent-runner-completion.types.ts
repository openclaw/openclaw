import type {
  SessionActorPendingFinalDelivery,
  SessionActorReducer,
} from "../../config/sessions/session-actor-contract.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";

export type AgentTurnCompletion = {
  current(): SessionEntry;
  refresh(): Promise<SessionEntry>;
  patch(
    reducer: SessionActorReducer | ((entry: SessionEntry) => SessionActorReducer | undefined),
  ): void;
  complete(pendingFinalDelivery?: SessionActorPendingFinalDelivery): Promise<SessionEntry>;
};
