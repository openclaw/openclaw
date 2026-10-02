import path from "node:path";
import { z } from "zod";
import { packageActivationIdentitySchema } from "./package-update-activation-schema.js";

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.resolve(value) === value && !value.includes("\0"));
const generation = z.strictObject({
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
  path: absolutePath,
  identity: packageActivationIdentitySchema,
  buildDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const ImmutableInstallDescriptorSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("immutable"),
  root: absolutePath,
  rootIdentity: packageActivationIdentitySchema,
  releasesIdentity: packageActivationIdentitySchema,
  current: generation.extend({ pointerIdentity: packageActivationIdentitySchema }),
  service: z.strictObject({
    unit: z.string().min(1).max(256),
    scope: z.literal("system"),
    account: z.string().min(1).max(256),
    stateDir: absolutePath,
    configPath: absolutePath,
    profile: z.string().min(1).max(256).nullable(),
  }),
  runtime: z.strictObject({
    path: absolutePath,
    identity: z.string().min(1).max(256),
  }),
  source: z.literal("https://github.com/openclaw/openclaw.git"),
});

export const ImmutablePreparedGenerationSchema = generation.extend({
  preparedAtMs: z.number().int().nonnegative(),
  schemaVersions: z.record(z.string().min(1).max(256), z.number().int().nonnegative()).optional(),
});

export const ImmutableInstallRecordSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  descriptor: ImmutableInstallDescriptorSchema,
  prepared: ImmutablePreparedGenerationSchema.nullable(),
});

export type ImmutableInstallDescriptor = z.infer<typeof ImmutableInstallDescriptorSchema>;
export type ImmutablePreparedGeneration = z.infer<typeof ImmutablePreparedGenerationSchema>;
export type ImmutableInstallRecord = z.infer<typeof ImmutableInstallRecordSchema>;
