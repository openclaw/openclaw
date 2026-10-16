import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../../infra/node-commands.js";
import type { WorkerProfile } from "../../plugins/types.js";
import type { EnvironmentRecipe } from "./environment-recipe.js";
import {
  WorkerPreparationTargetSchema,
  type WorkerPreparationArtifacts,
  type WorkerProjectPreparationIdentity,
} from "./preparation-identity.schema.js";
import type { WorkerProjectSnapshot } from "./workspace-git-base.js";

export type WorkerProviderPreparedIntent = {
  providerId: string;
  profileSnapshot: WorkerProfile;
  preparationKey?: string;
};

export function createWorkerPreparationIdentity(params: {
  namespace: string;
  providerId: string;
  profileId: string;
  profileSnapshot: WorkerProfile;
  project?: WorkerProjectSnapshot;
  target: WorkerProjectPreparationIdentity["target"];
  artifacts: WorkerPreparationArtifacts;
  setupRecipe?: string;
  runSetupScript?: boolean;
  recipe?: EnvironmentRecipe;
}): WorkerProjectPreparationIdentity {
  const artifacts = {
    ...params.artifacts,
    enabledPluginIds: [...new Set(params.artifacts.enabledPluginIds)].toSorted(),
    protocolFeatures: [...new Set(params.artifacts.protocolFeatures)].toSorted(),
  };
  // Skipping an executable recipe owns a separate cache; absent recipes do no setup.
  const facts = {
    contractVersion: 2 as const,
    ...(params.setupRecipe ? { setupRecipe: params.setupRecipe } : {}),
    ...(params.recipe ? { recipe: params.recipe } : {}),
    ...(params.setupRecipe && params.runSetupScript === false
      ? { runSetupScript: false as const }
      : {}),
    target: WorkerPreparationTargetSchema.parse(params.target),
    artifacts,
  };
  // Source root is transport location only: linked worktrees share Git identity.
  // The explicit contract version also invalidates Gateway-owned setup semantics.
  // The provider-resolved target owns OS identity, including an omitted default.
  const {
    os: _requestedOs,
    project: _project,
    runtimePreparation: _runtime,
    ...profile
  } = params.profileSnapshot;
  const compatibility = {
    contractVersion: facts.contractVersion,
    setupRecipe: facts.setupRecipe,
    runSetupScript: facts.runSetupScript,
    target: facts.target,
    namespace: params.namespace,
    providerId: params.providerId,
    // Providers own the disk fingerprint; unknown providers conservatively retain
    // their settings. Installation and execution mode belong to runtime readiness.
    profile: facts.target.profileKey ?? params.profileSnapshot.settings,
    project: params.project ? { key: params.project.key } : { source: "empty" },
    workspaceProtocol: NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
  };
  const digest = (value: unknown) =>
    createHash("sha256").update(stableStringify(value)).digest("hex");
  // Ready workers still bind exact runtime, profile and commit facts; reusable
  // disks only need compatible setup and boot inputs.
  return {
    key: digest({
      ...compatibility,
      artifacts,
      profileId: params.profileId,
      profile: {
        ...profile,
        machineClass: facts.target.machineClass,
        executionMode: params.profileSnapshot.executionMode ?? "worker-turn",
      },
      project: {
        ...compatibility.project,
        ...(params.project ? { baseCommit: params.project.baseCommit } : {}),
      },
    }),
    cacheKey: digest(compatibility),
    ...facts,
  };
}
