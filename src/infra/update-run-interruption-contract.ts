import type { z } from "zod";
import type { UpdateResultPayload } from "./update-result-payload.js";
import type { UpdateRunRecordSchema } from "./update-run-schema.js";

type UpdateRunRecord = z.infer<typeof UpdateRunRecordSchema>;

export type InterruptedUpdateSettlement = {
  expected: UpdateRunRecord;
  detail: string;
  verification?: UpdateRunRecord["verification"];
  cleanup?: "pending" | "unknown" | "confirmed";
};

export type InterruptedUpdateSettlementResult = {
  accepted: boolean;
  run?: UpdateRunRecord;
  updateResult?: UpdateResultPayload;
};
