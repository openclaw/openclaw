import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const revision = z.number().int().positive();
const ids = z
  .array(id)
  .min(1)
  .refine((values) => new Set(values).size === values.length);
const unique = <T extends z.ZodType>(schema: T) =>
  z
    .array(schema)
    .refine(
      (values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length,
    );
const phases = ["prepare", "quiesced-migrate", "postpublish-maintenance", "verify"] as const;
const installKinds = ["npm", "pnpm", "bun", "git", "immutable", "external-owned"] as const;
const platform = z.strictObject({
  os: z.enum(["linux", "darwin", "win32"]),
  arch: z.enum(["x64", "arm64"]),
  serviceMode: z.enum([
    "systemd",
    "launchd",
    "windows-service",
    "windows-task",
    "foreground-owned",
    "external-owned",
  ]),
});
const ref = z.strictObject({ id, revision });
const upgradeQualifiedExecutorSchema = z.strictObject({
  runnerManifestArtifactId: id,
  runtimeArtifactId: id,
  bootstrapArtifactId: id,
});
const adapterRef = ref.extend({ bundleArtifactId: id, parameterContractId: id });
const resource = z.strictObject({
  kind: z.enum([
    "package",
    "configuration",
    "state-db",
    "agent-db",
    "plugin-registry",
    "plugin-data",
    "service-definition",
    "runtime",
  ]),
  scope: z.enum(["installation", "active-profile", "all-participating-profiles"]),
  access: z.enum(["read", "write"]),
});

/** Declarative metadata only: neither validation nor qualification grants write authority. */
const upgradeRecipeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.enum(["fixture", "production"]),
  id,
  revision,
  summary: z.string().min(1).max(4096),
  catalogId: id,
  source: z.strictObject({
    releaseIds: ids,
    identityClasses: unique(z.enum(["verified-release", "recognized-modified"])).min(1),
    stateContractClasses: ids,
    installKinds: unique(z.enum(installKinds)).min(1),
    platforms: unique(platform).min(1),
  }),
  targetReleaseIds: ids,
  executor: z.strictObject({ protocol: revision, requiredCapabilities: ids }),
  steps: z
    .array(
      z.strictObject({
        id,
        adapter: adapterRef,
        phase: z.enum(phases),
        requires: z.array(id).refine((values) => new Set(values).size === values.length),
        resources: unique(resource).min(1),
        parameters: z.record(z.string(), z.json()),
        mutation: z.enum(["none", "private-stage", "live-state"]),
        postconditionContractIds: ids,
        recovery: z.strictObject({
          mode: z.enum([
            "no-write",
            "recompute-private",
            "transactional-reconcile",
            "verified-compensation",
            "manual",
          ]),
          contractId: id,
          snapshotRequired: z.boolean(),
        }),
      }),
    )
    .min(1),
  safety: z.strictObject({
    requiresQuiescence: z.literal(true),
    requiresMaintenanceGate: z.literal(true),
    policyContractIds: ids,
    rollbackContractId: id,
    unattendedEligible: z.boolean(),
  }),
  qualificationIds: unique(id).min(1),
  supersedes: unique(ref).optional(),
});

const artifact = z.strictObject({
  id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  length: z.number().int().positive(),
});
const release = z.strictObject({
  id,
  version: z.string().min(1),
  // Published build identities include case-sensitive ISO timestamp markers.
  buildId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  artifactId: id,
  // A separately authenticated manifest binds installed bytes, not merely package.version.
  installationManifestArtifactId: id.optional(),
  runtimeFamily: z.enum(["node", "bun"]),
  stateContracts: z.strictObject({
    state: z.number().int().nonnegative(),
    agent: z.number().int().nonnegative(),
  }),
});

/** Schema validity is not trust; the catalog authentication owner admits execution metadata. */
export const upgradeRecipeCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  artifacts: z.array(artifact),
  releases: z.array(release),
  recipes: z.array(upgradeRecipeSchema),
  adapters: z.array(
    adapterRef.extend({
      phases: z.array(z.enum(phases)).min(1),
      // Parameters are inert JSON. This first planner supports only parameter-free adapters.
      parameterContract: z.literal("empty-object"),
      inputStateContractClasses: ids,
      outputStateContractClass: id,
    }),
  ),
  // Signed intent allocates IDs, but makes no historical qualification claim.
  qualificationIntents: z
    .array(
      z.strictObject({
        recipe: ref,
        qualificationId: id,
        sourceReleaseId: id,
        targetReleaseId: id,
        runnerManifestArtifactId: id,
      }),
    )
    .optional(),
  qualifications: z.array(
    z.strictObject({
      id,
      recipe: ref,
      sourceReleaseId: id,
      targetReleaseId: id,
      installKind: z.enum(installKinds),
      platform,
      runtimeFamily: z.enum(["node", "bun"]),
      stateContractClass: id,
      evidenceArtifactId: id,
      executor: upgradeQualifiedExecutorSchema.optional(),
    }),
  ),
});

export type UpgradeRecipe = z.infer<typeof upgradeRecipeSchema>;
export type UpgradeRecipeCatalog = z.infer<typeof upgradeRecipeCatalogSchema>;
export type UpgradeRecipeStep = UpgradeRecipe["steps"][number];
