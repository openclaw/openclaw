// Secret input schema helpers validate plugin-declared credential prompts and storage metadata.
import { z } from "zod";
import { SecretRefSchema } from "../config/zod-schema.secret-input.js";
import { sensitive } from "../config/zod-schema.sensitive.js";

/**
 * Returns the shared secret-input schema for plaintext values and env/file/exec/store refs.
 * Reusing this singleton preserves sensitive-path registration for config redaction.
 */
export function buildSecretInputSchema() {
  return secretInputSchema;
}

/** Register a plugin-owned config schema leaf for redaction in host config projections. */
export function registerSensitiveConfigSchema<TSchema extends z.ZodType>(schema: TSchema): TSchema {
  sensitive.add(schema);
  return schema;
}

// Keep the SDK's published tuple order while sharing the config owner's validators.
const [envRef, fileRef, execRef, storeRef] = SecretRefSchema.options;
const secretInputSchema = z
  .union([z.string(), z.discriminatedUnion("source", [envRef, storeRef, fileRef, execRef])])
  .register(sensitive);
