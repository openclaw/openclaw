import type { z } from "zod";
import type {
  UpdateDoctorConfigChangeSchema,
  UpdateDoctorConfigWriteRefusalSchema,
} from "./update-doctor-config-schema.js";

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

export function createUpdateDoctorConfigWarningStep(
  root: string,
  changes: readonly UpdateDoctorConfigChange[],
) {
  const keys = [
    ...new Set(changes.flatMap((change) => (change.kind === "key" ? [change.key] : []))),
  ].toSorted();
  return {
    name: "candidate Doctor config",
    command: "report Doctor config changes",
    cwd: root,
    durationMs: 0,
    exitCode: 0,
    advisory: {
      kind: "recoverable-maintenance" as const,
      message: `Candidate Doctor changed keys ${keys.join(", ") || "none recorded"}; promotion receipts unavailable for this candidate version.`,
    },
  };
}
