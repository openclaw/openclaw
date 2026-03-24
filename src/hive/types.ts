import { z } from "zod";

/** Checked-in or CLI-supplied manifest: ClawHub slugs only (resolved via `src/infra/clawhub.ts`). */
export const SkillFeedV1Schema = z.object({
  version: z.literal(1),
  entries: z.array(
    z
      .object({
        slug: z.string().min(1),
        version: z.string().optional(),
      })
      .strict(),
  ),
});

export type SkillFeedV1 = z.infer<typeof SkillFeedV1Schema>;
