import path from "node:path";
import { z } from "zod";

export type ConfigFingerprint = string | ConfigFingerprint[] | { [key: string]: ConfigFingerprint };
export const immutableConfigFingerprintSchema: z.ZodType<ConfigFingerprint> = z.lazy(() =>
  z.union([
    z.string().regex(/^fp:[a-f0-9]{12}$/u),
    z.array(immutableConfigFingerprintSchema),
    z.record(z.string(), immutableConfigFingerprintSchema),
  ]),
);
const absolutePath = z
  .string()
  .min(1)
  .refine((value) => path.resolve(value) === value);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const immutableProtectedFileIdentitySchema = z.strictObject({
  dev: z.string(),
  ino: z.string(),
  mode: z.number().int(),
  nlink: z.literal(1),
  uid: z.number().int(),
  gid: z.number().int(),
});
const pathProof = z.strictObject({
  targetPath: absolutePath,
  entries: z.array(
    z.union([
      z.strictObject({ path: absolutePath, kind: z.literal("missing-directory") }),
      z.strictObject({
        path: absolutePath,
        kind: z.literal("existing"),
        dev: z.string(),
        ino: z.string(),
        link: z.string().optional(),
      }),
    ]),
  ),
});

/** Recovery retains fingerprints and path facts, never config values or credentials. */
export const ImmutableProtectionSnapshotSchema = z.strictObject({
  capturedAtMs: z.number().int().nonnegative(),
  auditBoundary: hash.nullable(),
  state: z.strictObject({
    path: absolutePath,
    identity: immutableProtectedFileIdentitySchema,
    pathProof,
    key: z.string(),
    birthtime: z.string().optional(),
  }),
  config: z
    .array(
      z.strictObject({
        path: absolutePath,
        identity: immutableProtectedFileIdentitySchema,
        pathProof,
        hash,
        fingerprint: immutableConfigFingerprintSchema,
        policyFingerprint: hash,
      }),
    )
    .min(1),
});
export type ImmutableProtectionSnapshot = z.infer<typeof ImmutableProtectionSnapshotSchema>;
