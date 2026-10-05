import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { z } from "zod";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../../infra/node-commands.js";
import type { WorkerProfile } from "../../plugins/types.js";
import type { ImageReserveProject } from "./image-reserve.js";
import type { WorkerProjectSnapshot } from "./workspace-git-base.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Artifacts = z
  .object({
    nodeBootstrapSha256: Digest,
    enabledPluginIds: z.array(z.string().min(1).max(256)).max(256),
    workerBundleHash: Digest,
    workerArchiveSha256: Digest,
    openclawVersion: z.string().min(1).max(128),
    protocolFeatures: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict();
const Target = z
  .object({
    machineClass: z.string().min(1).max(256),
    platform: z.string().min(1).max(64),
    arch: z.string().min(1).max(64).optional(),
  })
  .strict();
const Preparation = z
  .object({
    key: Digest,
    cacheKey: Digest,
    contractVersion: z.literal(1),
    setupRecipe: z
      .string()
      .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)
      .optional(),
    runSetupScript: z.boolean().optional(),
    target: Target,
    artifacts: Artifacts,
  })
  .strict();

export type WorkerPreparationArtifacts = z.infer<typeof Artifacts>;
export type WorkerProjectPreparationIdentity = z.infer<typeof Preparation>;
export type WorkerProviderPreparedIntent = {
  providerId: string;
  profileSnapshot: WorkerProfile;
  preparationKey?: string;
};

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

function preparationProfileIdentity(
  profileSnapshot: WorkerProfile,
  target: WorkerProjectPreparationIdentity["target"],
): WorkerProfile {
  const { os: _requestedOs, ...profile } = profileSnapshot;
  return {
    ...profile,
    machineClass: target.machineClass,
    executionMode: profileSnapshot.executionMode ?? "worker-turn",
  };
}

/** Image reserves share machine/runtime facts; the session owns repository checkout and setup. */
export function isWorkerImagePreparationCompatible(
  reserve: WorkerProfile,
  requested: WorkerProfile,
): boolean {
  const left = readWorkerProjectPreparation(reserve.project);
  const right = readWorkerProjectPreparation(requested.project);
  const { project: _reserveProject, ...reserveProfile } = reserve;
  const { project: _requestedProject, ...requestedProfile } = requested;
  return Boolean(
    left &&
    right &&
    isDeepStrictEqual(left.target, right.target) &&
    isDeepStrictEqual(left.artifacts, right.artifacts) &&
    isDeepStrictEqual(
      preparationProfileIdentity(reserveProfile, left.target),
      preparationProfileIdentity(requestedProfile, right.target),
    ),
  );
}

export function createWorkerProjectPreparationIdentity(params: {
  namespace: string;
  providerId: string;
  profileId: string;
  profileSnapshot: WorkerProfile;
  project: WorkerProjectSnapshot | ImageReserveProject;
  target: WorkerProjectPreparationIdentity["target"];
  artifacts: WorkerPreparationArtifacts;
  setupRecipe?: string;
  runSetupScript?: boolean;
}): WorkerProjectPreparationIdentity {
  const artifacts = Artifacts.parse(params.artifacts);
  artifacts.enabledPluginIds = [...new Set(artifacts.enabledPluginIds)].toSorted();
  artifacts.protocolFeatures = [...new Set(artifacts.protocolFeatures)].toSorted();
  // Skipping an executable recipe owns a separate cache; absent recipes do no setup.
  const facts = {
    contractVersion: 1 as const,
    ...(params.setupRecipe ? { setupRecipe: params.setupRecipe } : {}),
    ...(params.setupRecipe && params.runSetupScript === false
      ? { runSetupScript: false as const }
      : {}),
    target: Target.parse(params.target),
    artifacts,
  };
  // Source root is transport location only: linked worktrees share Git identity.
  // The explicit contract version also invalidates Gateway-owned setup semantics.
  // The provider-resolved target owns OS identity, including an omitted default.
  const compatibility = {
    ...facts,
    namespace: params.namespace,
    providerId: params.providerId,
    profileId: params.profileId,
    profile: preparationProfileIdentity(params.profileSnapshot, facts.target),
    project: { key: params.project.key },
    workspaceProtocol: NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
  };
  const digest = (value: unknown) =>
    createHash("sha256").update(stableStringify(value)).digest("hex");
  // A repository reserve is capacity for a future session-selected commit. Its
  // cached checkout may accelerate a matching claim, but a moved branch must not
  // retire the worker: a different commit takes the ordinary checkout path.
  const { setupRecipe: _repositoryRecipe, ...repositoryCompatibility } = compatibility;
  const reusable = "source" in params.project || "kind" in params.project;
  return {
    key: digest({
      ...(reusable ? repositoryCompatibility : compatibility),
      project: reusable
        ? compatibility.project
        : {
            ...compatibility.project,
            baseCommit: "baseCommit" in params.project ? params.project.baseCommit : undefined,
          },
    }),
    cacheKey: digest(compatibility),
    ...facts,
  };
}
