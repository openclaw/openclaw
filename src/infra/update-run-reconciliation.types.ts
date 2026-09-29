import type { z } from "zod";
import type { UpdateRunRecordSchema } from "./update-run-schema.js";

type UpdateRunRecord = z.infer<typeof UpdateRunRecordSchema>;

export type UpdateRunReconciliationInput = {
  explicit?: boolean;
  runIds?: readonly string[];
  requireAllActive?: boolean;
  legacyOnly?: boolean;
  /** Lightweight repair must still exclude unfinished post-core work at commit. */
  repairHistorySinceMs?: number;
};
export type UpdateRunReconciliationCandidate = {
  record: UpdateRunRecord;
  rule: string | undefined;
};

export type UpdateRunReconciliationResult = {
  current: UpdateRunRecord[];
  reconciled: UpdateRunRecord[];
};

export type UpdateRunReconciliationOperations = {
  "updateRuns.reconcile": {
    input: {
      candidates: UpdateRunReconciliationCandidate[];
      selection: UpdateRunReconciliationInput;
      busyTimeoutMs?: number;
      redactPaths?: readonly string[];
    };
    output: UpdateRunReconciliationResult;
  };
};
