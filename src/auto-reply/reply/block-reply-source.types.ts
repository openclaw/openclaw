import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatch-outcome.types.js";

export type BlockReplySource = {
  readonly complete: boolean;
  readonly pending: boolean;
  setComplete: (complete: boolean) => void;
  run: <T>(send: () => Promise<T>) => Promise<T | undefined>;
  settle: () => Promise<{ outcome: ReplyDispatchDeliveryOutcome; pending?: boolean }>;
  recoverPartial: (payload: ReplyPayload) => ReplyPayload;
};
