import { z } from "zod";

export const UpdateDoctorConfigChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string() }),
  z.object({ kind: z.literal("migration"), message: z.string() }),
]);

export const UpdateDoctorConfigWriteRefusalSchema = z.object({
  reason: z.string(),
  message: z.string(),
  keys: z.array(z.string()),
});
