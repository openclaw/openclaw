import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { EnvironmentRecipeSchema } from "./environment-recipe.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const WorkerPreparationArtifactsSchema = z
  .object({
    nodeBootstrapSha256: Digest,
    enabledPluginIds: z.array(z.string().min(1).max(256)).max(256),
    workerBundleHash: Digest,
    workerArchiveSha256: Digest,
    openclawVersion: z.string().min(1).max(128),
    protocolFeatures: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict();
export const WorkerPreparationTargetSchema = z
  .object({
    machineClass: z.string().min(1).max(256),
    platform: z.string().min(1).max(64),
    arch: z.string().min(1).max(64).optional(),
    profileKey: Digest.optional(),
  })
  .strict();
const Preparation = z
  .object({
    key: Digest,
    cacheKey: Digest,
    // Persisted v1 allocations remain readable for replay and cleanup.
    contractVersion: z.union([z.literal(1), z.literal(2)]),
    setupRecipe: z
      .string()
      .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)
      .optional(),
    runSetupScript: z.boolean().optional(),
    recipe: EnvironmentRecipeSchema.optional(),
    target: WorkerPreparationTargetSchema,
    artifacts: WorkerPreparationArtifactsSchema,
  })
  .strict();

const EmptyPreparation = Preparation.omit({
  setupRecipe: true,
  runSetupScript: true,
  recipe: true,
}).extend({
  source: z.literal("empty"),
});

export type WorkerPreparationArtifacts = z.infer<typeof WorkerPreparationArtifactsSchema>;
export type WorkerProjectPreparationIdentity = z.infer<typeof Preparation>;

/** Immutable artifact facts are separate from the reserve's demand/expiry/consumption tuple. */
export function readWorkerProjectPreparation(
  project: unknown,
): WorkerProjectPreparationIdentity | undefined {
  if (!isRecord(project) || project.preparation === undefined) {
    return undefined;
  }
  const parsed = Preparation.safeParse(project.preparation);
  if (!parsed.success) {
    throw new Error("Worker project preparation identity is invalid");
  }
  return parsed.data;
}

export function readWorkerPreparation(
  profile: Readonly<Record<string, unknown>>,
): WorkerProjectPreparationIdentity | undefined {
  if (profile.runtimePreparation === undefined) {
    return readWorkerProjectPreparation(profile.project);
  }
  const parsed = EmptyPreparation.safeParse(profile.runtimePreparation);
  if (!parsed.success || profile.project !== undefined) {
    throw new Error("Worker runtime preparation identity is invalid");
  }
  return parsed.data;
}

export function workerPreparationSourceKey(profile: Readonly<Record<string, unknown>>) {
  if (profile.runtimePreparation !== undefined) {
    readWorkerPreparation(profile);
    // Capacity spans runtime generations; the preparation key separately fences
    // claims by namespace, settings, execution mode, and exact artifacts.
    return "empty";
  }
  return isRecord(profile.project) ? Digest.parse(profile.project.key) : undefined;
}
