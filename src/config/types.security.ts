import { z } from "zod";

export const GuardModelConfigSchema = z
  .object({
    /** Enable the guard model for sanitizing external content. */
    enabled: z.boolean().optional(),
    /** Model to use as the guard (e.g., "flash", "haiku"). Should be cheap and fast. */
    model: z.string().optional(),
    /** Maximum tokens for guard model output (default: 500). */
    maxTokens: z.number().int().positive().optional(),
    /** Timeout for guard model invocation in seconds (default: 10). */
    timeoutSeconds: z.number().int().positive().optional(),
    /** Behavior when the guard model fails or times out. */
    onFailure: z.enum(["passthrough", "block", "warn"]).optional(),
    /** Allowlist of trusted sources that bypass the guard model. */
    allowlist: z.array(z.string()).optional(),
  })
  .strict();

export type GuardModelConfig = z.infer<typeof GuardModelConfigSchema>;
