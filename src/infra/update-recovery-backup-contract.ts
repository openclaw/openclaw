import { z } from "zod";
import { updateRecoveryCaptureStateSchema } from "./update-recovery-receipt-schema.js";
type UpdateRecoveryCaptureState = z.infer<typeof updateRecoveryCaptureStateSchema>;
export type UpdateRecoveryConfigWrite = UpdateRecoveryCaptureState["configWrites"][number];
export const updateRecoveryBackupRefSchema = z
  .object({
    directory: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type UpdateRecoveryBackupRef = z.infer<typeof updateRecoveryBackupRefSchema>;

/** Merge one owner-authored receipt update without dropping previously sealed fields. */
export function mergeUpdateRunRecoveryCaptureState(
  record: { origin: { updateRecoveryCapture?: UpdateRecoveryCaptureState } },
  patch: Partial<UpdateRecoveryCaptureState> & { manifestSha256: string },
): UpdateRecoveryCaptureState {
  const current = record.origin.updateRecoveryCapture;
  return updateRecoveryCaptureStateSchema.parse({
    ...current,
    ...patch,
    status: patch.status ?? current?.status ?? "pending",
    configWrites: patch.configWrites ?? current?.configWrites ?? [],
  });
}
