// Defines Zod schema fragments for skill-related config.
import { z } from "zod";

export const SkillFilterMergeSchema = z
  .object({
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  })
  .strict()
  .refine((value) => (value.add?.length ?? 0) + (value.remove?.length ?? 0) > 0, {
    message: "skillsMerge requires at least one skill in add or remove",
  });
