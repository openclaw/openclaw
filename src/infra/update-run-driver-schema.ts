import { z } from "zod";

export const UpdateRunDriverSchema = z.object({
  host: z.string().min(1).max(255),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startIdentity: z.string().max(128).regex(/^\d+$/),
});
