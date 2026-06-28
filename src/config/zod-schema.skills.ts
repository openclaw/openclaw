// Defines Zod schema fragments for skill-related config.
import { z } from "zod";

export const SkillFilterMergeSchema = z
  .object({
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  })
  .strict();
