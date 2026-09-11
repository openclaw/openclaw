import { z } from "zod";

export const CLAWHUB_RECOMMENDATION_LIMIT = 3;
export const CLAWHUB_RECOMMENDATIONS_CHANNEL_DATA_KEY = "openclawClawHubRecommendations";

const recommendationFields = {
  type: z.literal("clawhub"),
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(120),
  description: z.string().max(240).optional(),
  iconUrl: z.string().url().max(2048).optional(),
  installed: z.boolean(),
  official: z.literal(true),
};
const skillReference = z
  .string()
  .max(256)
  .regex(/^@[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i);

const recommendationSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...recommendationFields,
        kind: z.literal("plugin"),
        id: z
          .string()
          .max(512)
          .regex(/^ch_[A-Za-z0-9_-]+$/),
        pluginId: z.string().max(256).optional(),
      })
      .strict(),
    z
      .object({
        ...recommendationFields,
        kind: z.literal("skill"),
        registry: z.string().url().max(2048),
        id: skillReference,
        skillRef: skillReference,
      })
      .strict(),
  ])
  .refine((entry) => entry.kind !== "skill" || entry.id === entry.skillRef);

/** Gateway-authored catalog identity and install facts; models supply only a search query. */
export type ClawHubRecommendation = z.infer<typeof recommendationSchema>;

export function readClawHubRecommendation(value: unknown): ClawHubRecommendation | undefined {
  const result = recommendationSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function readClawHubRecommendations(
  channelData: Record<string, unknown> | undefined,
): ClawHubRecommendation[] {
  const result = z
    .array(recommendationSchema)
    .max(CLAWHUB_RECOMMENDATION_LIMIT)
    .safeParse(channelData?.[CLAWHUB_RECOMMENDATIONS_CHANNEL_DATA_KEY]);
  return result.success ? result.data : [];
}
