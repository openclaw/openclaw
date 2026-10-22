import type { CronStoredJob } from "./types.js";

export type DefaultProactiveJobReceipt = {
  jobId: string;
  provisionedAtMs: number;
  phase: "pending" | "complete";
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
