import { z } from "zod";
import { DecisionModelSchema } from "./zod-schema.agent-model.js";

export const ModelCatalogRefreshConfigSchema = z
  .object({
    /** Fetch model catalog updates from the hosted OpenClaw catalog. Default: true. */
    enabled: z.boolean().optional(),
    /** Override the hosted catalog URL (HTTPS mirrors, or localhost HTTP for testing). */
    url: z
      .string()
      .refine(
        (value) => {
          try {
            const parsed = new URL(value);
            return (
              parsed.protocol === "https:" ||
              (parsed.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
            );
          } catch {
            return false;
          }
        },
        {
          message: "models.catalogRefresh.url must use https, or http on localhost",
        },
      )
      .optional(),
  })
  .strict()
  .optional();

/** Saved choices only; does not alter runtime selection or authorization. */
export const DecisionModelInventorySchema = z
  .array(DecisionModelSchema.refine((value) => value !== "", "Expected provider/model."))
  .transform((models) => [...new Set(models)])
  .optional();
