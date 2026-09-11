import { z } from "zod";

export const UpdateDoctorConfigChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string() }),
  z.object({ kind: z.literal("migration"), message: z.string() }),
]);
export type UpdateDoctorConfigChange = z.infer<typeof UpdateDoctorConfigChangeSchema>;

export const UpdateDoctorConfigWriteRefusalSchema = z.object({
  reason: z.string(),
  message: z.string(),
  keys: z.array(z.string()),
});
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
