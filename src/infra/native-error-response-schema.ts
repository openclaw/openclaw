import { z } from "zod";

const nativeErrorDetailsSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  errcode: z.number().optional(),
});

export const nativeErrorResponseSchema = nativeErrorDetailsSchema.extend({
  name: z.string(),
  cause: nativeErrorDetailsSchema.optional(),
});

export type NativeErrorResponse = z.infer<typeof nativeErrorResponseSchema>;
