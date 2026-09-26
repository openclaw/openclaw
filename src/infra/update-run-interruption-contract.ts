import type { UpdateRunRecord } from "./update-run-record.js";

export type InterruptedUpdateSettlement = {
  expected: UpdateRunRecord;
  detail: string;
  verification?: UpdateRunRecord["verification"];
  cleanup?: "pending" | "unknown" | "confirmed";
};

export type InterruptedUpdateSettlementResult = { accepted: boolean; run?: UpdateRunRecord };
