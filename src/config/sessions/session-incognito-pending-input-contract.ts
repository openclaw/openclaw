import type { IncognitoHistoryTarget } from "./session-incognito-history-contract.js";
import type { PendingInputHistoryReceipt } from "./session-pending-input-history.types.js";

export type IncognitoPendingInputOperations = {
  "session.pendingInputs.interruptHistory": {
    input: IncognitoHistoryTarget & { ids: string[] };
    output: PendingInputHistoryReceipt;
  };
};
