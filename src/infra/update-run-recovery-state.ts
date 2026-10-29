import type { z } from "zod";
import type { UpdateRunRecordSchema } from "./update-run-schema.js";

export type UpdateRunRecoveryState = Pick<
  z.infer<typeof UpdateRunRecordSchema>,
  | "status"
  | "phase"
  | "reason"
  | "createdAtMs"
  | "updatedAtMs"
  | "finishedAtMs"
  | "origin"
  | "steps"
>;
