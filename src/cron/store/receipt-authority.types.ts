import type {
  CronRunReceiptCurrentFacts,
  CronRunReceiptCurrentReadCommand,
} from "./run-receipt.types.js";

/** Private, bounded publication input; these identifiers never grant execution authority. */
export type CronReceiptAuthorityAttachment = {
  nonce: string;
  reads: CronRunReceiptCurrentReadCommand[];
};

export type CronReceiptAuthorityPublication = {
  nonce: string;
  sequence: number;
  /** Native SDK writers publish invalidation; the retained owner rebuilds after settlement. */
  receipts?: CronRunReceiptCurrentFacts[];
};
