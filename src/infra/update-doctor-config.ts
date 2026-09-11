import type { z } from "zod";
import type {
  UpdateDoctorConfigChangeSchema,
  UpdateDoctorConfigWriteRefusalSchema,
} from "./update-doctor-config-schema.js";
import type { UpdateStepResult } from "./update-runner-types.js";

export type UpdateDoctorConfigChange = z.infer<typeof UpdateDoctorConfigChangeSchema>;
export type UpdateDoctorConfigWriteRefusal = z.infer<typeof UpdateDoctorConfigWriteRefusalSchema>;

export function formatUpdateDoctorConfigWriteRefusal(
  refusal: UpdateDoctorConfigWriteRefusal,
): string {
  return `Doctor config promotion refused for top-level keys: ${refusal.keys.join(", ") || "none recorded"}. ${refusal.reason}: ${refusal.message}`;
}

export function formatUpdateDoctorConfigChange(change: UpdateDoctorConfigChange): string {
  return change.kind === "key"
    ? `Doctor changed config key: ${change.key}.`
    : `Doctor migration: ${change.message}`;
}

export function getUpdateDoctorConfigFailureReason(refusal?: UpdateDoctorConfigWriteRefusal) {
  return refusal
    ? refusal.reason === "requester-revoked"
      ? "requester-revoked"
      : "repair-requires-config-change"
    : undefined;
}

export function createUpdateDoctorPromotionUnavailableStep(
  root: string,
  changes: readonly UpdateDoctorConfigChange[],
): UpdateStepResult {
  const keys = [
    ...new Set(changes.flatMap((change) => (change.kind === "key" ? [change.key] : []))),
  ].toSorted();
  return {
    name: "candidate Doctor promotion",
    command: "verify Doctor write authority",
    cwd: root,
    durationMs: 0,
    exitCode: 1,
    stdoutTail: `Config keys: ${keys.join(", ")}.`,
    stderrTail:
      "This candidate cannot fence Doctor config promotion; select a candidate with guarded Doctor writes.",
  };
}
