import { z } from "zod";

export const UpdateDoctorConfigHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const UpdateDoctorConfigFileWriteSchema = z.object({
  inputHash: UpdateDoctorConfigHashSchema.optional(),
  hash: UpdateDoctorConfigHashSchema,
});

export const UpdateDoctorConfigChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string() }),
  z.object({ kind: z.literal("migration"), message: z.string() }),
]);

export const UpdateDoctorConfigWriteRefusalSchema = z.object({
  reason: z.string(),
  message: z.string(),
  keys: z.array(z.string()),
});
