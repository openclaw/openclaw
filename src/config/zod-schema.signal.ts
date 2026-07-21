import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { ExecutableTokenSchema } from "./zod-schema.core.js";

export const SIGNAL_RETIRED_TRANSPORT_KEYS = [
  "apiMode",
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "autoStart",
  "startupTimeoutMs",
  "receiveMode",
  "ignoreStories",
] as const;

const SIGNAL_TRANSPORT_URL_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/(?![^/?#]*@)/;
const SignalTransportUrlSchema = z
  .string()
  .url()
  // Keep this as a regex so the HTTP-only and credential-free contract survives JSON Schema
  // generation. Runtime URL parsing remains the final canonicalization boundary.
  .regex(
    SIGNAL_TRANSPORT_URL_PATTERN,
    "Expected http:// or https:// URL without embedded credentials",
  );

export function projectSignalConfigForUpdateValidation(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" || !isRecord(value)) {
    return value;
  }
  const next = { ...value };
  for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
    delete next[key];
  }
  if (isRecord(value.accounts)) {
    next.accounts = Object.fromEntries(
      Object.entries(value.accounts).map(([accountId, account]) => {
        if (!isRecord(account)) {
          return [accountId, account];
        }
        const nextAccount = { ...account };
        for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
          delete nextAccount[key];
        }
        return [accountId, nextAccount];
      }),
    );
  }
  return next;
}

export const SignalTransportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("managed-native"),
      configPath: z.string().optional(),
      url: SignalTransportUrlSchema.optional(),
      httpHost: z.string().optional(),
      httpPort: z.number().int().min(1).max(65_535).optional(),
      cliPath: ExecutableTokenSchema.optional(),
      startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
      ignoreStories: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external-native"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
]);
