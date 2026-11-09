import path from "node:path";
import { z } from "zod";
import { packageActivationIdentitySchema } from "./package-update-activation-schema.js";

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.resolve(value) === value && !value.includes("\0"));
export const ImmutableRecoveryRuntimeReferenceSchema = z.strictObject({
  root: absolutePath,
  path: absolutePath,
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
  identity: packageActivationIdentitySchema,
  buildDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  helperPath: absolutePath,
  helperIdentity: packageActivationIdentitySchema,
  helperDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ImmutableRecoveryRuntimeReference = z.infer<
  typeof ImmutableRecoveryRuntimeReferenceSchema
>;
