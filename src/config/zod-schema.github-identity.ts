import { z } from "zod";
import { MANAGED_GITHUB_PROFILE_ID_PATTERN } from "./github-identity-profile-id.js";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { sensitive } from "./zod-schema.sensitive.js";

const identityFields = {
  profileId: z.string().regex(MANAGED_GITHUB_PROFILE_ID_PATTERN),
  gitAuthor: z
    .strictObject({
      name: z.string().trim().min(1).optional(),
      email: z.string().trim().min(1).optional(),
    })
    .optional(),
};
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const GitHubAppInstallationSchema = z.strictObject({
  appId: id,
  installationId: id,
  accountId: id,
  repositories: z
    .array(
      z.strictObject({
        id,
        fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      }),
    )
    .min(1)
    .max(100)
    .refine((values) => new Set(values.map((value) => value.id)).size === values.length),
  permissions: z.record(z.string().regex(/^[a-z_]+$/u), z.enum(["read", "write"])),
  privateKey: SecretInputSchema.register(sensitive),
  keyVersion: z.string().trim().min(1).max(256),
});

const credentialSchemas = [
  z.strictObject({ ...identityFields, kind: z.literal("oauth").optional() }),
  z.strictObject({
    ...identityFields,
    kind: z.literal("app-installation"),
    app: GitHubAppInstallationSchema,
  }),
] as const;
export const GitHubToolIdentitySchema = z.union(credentialSchemas).optional();
export const AgentGitHubToolIdentitySchema = z
  .union(
    credentialSchemas.map((schema) => schema.extend({ allowInSandbox: z.boolean().optional() })),
  )
  .optional();
