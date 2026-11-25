import type { CronStoreSelection } from "./store/selection.types.js";
import type { CronStoredJob } from "./types.js";

export type DefaultProactiveJobReceipt = {
  jobId: string;
  provisionedAtMs: number;
  phase: "pending" | "complete";
  /** Original migration intent, retained until the cutover transfers ownership. */
  heartbeatEnabled?: boolean;
  convertedJobIds?: string[];
};

type ProactiveJobReceiptReadInput = {
  storeKey: string;
  agentIds: string[];
};

export type ProactiveJobReceiptReadOperations = {
  "automationProactive.storeSelection": {
    input: { storePath?: string; defaultStorePath: string };
    output: { type: "automationProactive.storeSelection"; selection: CronStoreSelection };
  };
  "automationProactive.receipts": {
    input: ProactiveJobReceiptReadInput;
    output: {
      type: "automationProactive.receipts";
      receipts: Record<string, DefaultProactiveJobReceipt>;
    };
  };
  "automationProactive.jobs": {
    input: ProactiveJobReceiptReadInput;
    output: { type: "automationProactive.jobs"; jobs: CronStoredJob[] };
  };
};
