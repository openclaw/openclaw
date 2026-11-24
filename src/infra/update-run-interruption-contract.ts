import type { UpdateResultPayload } from "./update-result-payload.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type InterruptedUpdateSettlement = {
  expected: UpdateRunRecord;
  detail: string;
  verification?: UpdateRunRecord["verification"];
  cleanup?: "pending" | "unknown" | "confirmed";
  /** Exact explicit repair whose persisted maintenance receipts permit legacy completion. */
  legacyRepairRunId?: string;
};

export type InterruptedUpdateSettlementResult = {
  accepted: boolean;
  run?: UpdateRunRecord;
  updateResult?: UpdateResultPayload;
};
