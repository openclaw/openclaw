import { z } from "zod";
import {
  ENV_SECRET_REF_ID_RE,
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  SECRET_PROVIDER_ALIAS_PATTERN,
} from "../secrets/ref-contract.js";

const SecretRefProviderSchema = z
  .string()
  .regex(
    SECRET_PROVIDER_ALIAS_PATTERN,
    'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
  );

function createSecretRefSchema<const TSource extends string>(source: TSource, id: z.ZodString) {
  return z.strictObject({ source: z.literal(source), provider: SecretRefProviderSchema, id });
}

/** Config-level secret reference schema shared by model/provider/plugin credential fields. */
export const SecretRefSchema = z.discriminatedUnion("source", [
  createSecretRefSchema(
    "env",
    z
      .string()
      .regex(
        ENV_SECRET_REF_ID_RE,
        'Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
      ),
  ),
  createSecretRefSchema(
    "file",
    z
      .string()
      .refine(
        isValidFileSecretRefId,
        'File secret reference id must be an absolute JSON pointer (example: "/providers/openai/apiKey"), or "value" for singleValue mode.',
      ),
  ),
  createSecretRefSchema(
    "exec",
    z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage()),
  ),
  createSecretRefSchema(
    "store",
    z
      .string()
      .regex(
        ENV_SECRET_REF_ID_RE,
        'Store secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
      ),
  ),
]);

/** Accepts either legacy inline secret strings or structured secret references. */
export const SecretInputSchema = z.union([z.string(), SecretRefSchema]);
