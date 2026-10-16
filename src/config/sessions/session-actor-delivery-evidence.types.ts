import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";

/** Already validated by the host; live authority is checked again at commit. */
export type SessionActorDeliveryEvidence = {
  claim?: HarnessCompletionRecovery;
  result?: {
    channel: string;
    target?: { id: string };
    platformMessageId?: string;
    resultCount?: number;
    /** Host validated every reported physical route against this exact captured context. */
    verifiedContext?: DeliveryContext;
  };
};
