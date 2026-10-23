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
  storePath: string | undefined;
  agentIds: string[];
};

export type ProactiveJobReceiptReadOperations = {
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
