import { z } from "zod";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  SECRET_PROVIDER_ALIAS_PATTERN,
} from "../secrets/ref-contract.js";
import { ENV_SECRET_REF_ID_RE } from "./types.secrets.js";

const EnvSecretRefSchema = z
  .object({
    source: z.literal("env"),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    id: z
      .string()
      .regex(
        ENV_SECRET_REF_ID_RE,
        'Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
      ),
  })
  .strict();

const FileSecretRefSchema = z
  .object({
    source: z.literal("file"),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    id: z
      .string()
      .refine(
        isValidFileSecretRefId,
        'File secret reference id must be an absolute JSON pointer (example: "/providers/openai/apiKey"), or "value" for singleValue mode.',
      ),
  })
  .strict();

const ExecSecretRefSchema = z
  .object({
    source: z.literal("exec"),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage()),
  })
  .strict();

const StoreSecretRefSchema = z
  .object({
    source: z.literal("store"),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    id: z
      .string()
      .regex(
        ENV_SECRET_REF_ID_RE,
        'Store secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
      ),
  })
  .strict();

/** Config-level secret reference schema shared by model/provider/plugin credential fields. */
export const SecretRefSchema = z.discriminatedUnion("source", [
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
  StoreSecretRefSchema,
]);

/** Accepts either legacy inline secret strings or structured secret references. */
export const SecretInputSchema = z.union([z.string(), SecretRefSchema]);
