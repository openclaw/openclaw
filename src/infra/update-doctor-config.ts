import type { z } from "zod";
import type {
  UpdateDoctorConfigChangeSchema,
  UpdateDoctorConfigFileWriteSchema,
  UpdateDoctorConfigWriteRefusalSchema,
} from "./update-doctor-config-schema.js";

export type UpdateDoctorConfigChange = z.infer<typeof UpdateDoctorConfigChangeSchema>;
export type UpdateDoctorConfigWriteRefusal = z.infer<typeof UpdateDoctorConfigWriteRefusalSchema>;

export type DoctorConfigCapture = {
  path: string;
  hash: string;
  inputHash?: string;
  fileWrites?: Record<string, z.infer<typeof UpdateDoctorConfigFileWriteSchema>>;
  configChanges: UpdateDoctorConfigChange[];
  configWriteRefusal?: UpdateDoctorConfigWriteRefusal;
  deferredInspectionCheckIds?: string[];
  warnings?: string[];
};

/** The only authority fields held by a config write capture. */
export type DoctorConfigWriteAuthority = { inputHash: string; assertCurrent: () => void };

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
