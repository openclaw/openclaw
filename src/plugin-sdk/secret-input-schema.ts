import { z } from "zod";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  SECRET_PROVIDER_ALIAS_PATTERN,
} from "../secrets/ref-contract.js";

/** Build the shared zod schema for secret inputs accepted by plugin auth/config surfaces. */
export function buildSecretInputSchema() {
  const providerSchema = z
    .string()
    .regex(
      SECRET_PROVIDER_ALIAS_PATTERN,
      'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
    );

  return z.union([
    z.string(),
    z.discriminatedUnion("source", [
      z.object({
        source: z.literal("env"),
        provider: providerSchema,
        id: z
          .string()
          .regex(
            ENV_SECRET_REF_ID_RE,
            'Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
          ),
      }),
      z.object({
        source: z.literal("file"),
        provider: providerSchema,
        id: z
          .string()
          .refine(
            isValidFileSecretRefId,
            'File secret reference id must be an absolute JSON pointer (example: "/providers/openai/apiKey"), or "value" for singleValue mode.',
          ),
      }),
      z.object({
        source: z.literal("exec"),
        provider: providerSchema,
        id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage()),
      }),
    ]),
  ]);
}
