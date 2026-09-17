import type {
  getOperatorApprovalDetailed,
  listTerminalOperatorApprovals,
} from "./operator-approval-store.js";

export type OperatorApprovalWorkerOperations = {
  "operatorApproval.getDetailed": {
    input: Omit<Parameters<typeof getOperatorApprovalDetailed>[0], "databaseOptions">;
    output: ReturnType<typeof getOperatorApprovalDetailed>;
  };
  "operatorApproval.history": {
    input: Omit<
      NonNullable<Parameters<typeof listTerminalOperatorApprovals>[0]>,
      "databaseOptions"
    >;
    output: { ok: true; history: ReturnType<typeof listTerminalOperatorApprovals> } | { ok: false };
  };
};
