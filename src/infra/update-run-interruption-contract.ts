import type { LegacyTrialReceipt } from "../update/legacy-trial-record.js";
import type { UpdateResultPayload } from "./update-result-payload.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export type InterruptedUpdateSettlement = {
  detail: string;
} & (
  | {
      expected: UpdateRunRecord;
      verification?: UpdateRunRecord["verification"];
      cleanup?: "pending" | "unknown" | "confirmed";
      legacyReady?: never;
    }
  | {
      expected?: never;
      verification: UpdateRunRecord["verification"];
      cleanup?: never;
      legacyReady: LegacyTrialReceipt;
    }
);

export type InterruptedUpdateSettlementResult = {
  accepted: boolean;
  retry?: true;
  run?: UpdateRunRecord;
  updateResult?: UpdateResultPayload;
};
