import type { UpdateResultPayload } from "./update-result-payload.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type InterruptedUpdateSettlement = {
  expected: UpdateRunRecord;
  detail: string;
  verification?: UpdateRunRecord["verification"];
  cleanup?: "pending" | "unknown" | "confirmed";
  /** Core readiness observed by the selected release, under its existing worker admission. */
  legacyReady?: true;
};

export type InterruptedUpdateSettlementResult = {
  accepted: boolean;
  run?: UpdateRunRecord;
  updateResult?: UpdateResultPayload;
};
