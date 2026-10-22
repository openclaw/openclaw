import type {
  EnvironmentSummary,
  EnvironmentsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { WorkerRecipePreparation } from "../../../../src/plugins/capability-provider.types.js";
import type { CloudWorkerRepository } from "./cloud-worker-repositories-config.ts";

export type SnapshotImage = {
  profileKey: string;
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  projectKey?: string;
  projectLabel?: string;
  projectRoot?: string;
  checkpointId?: string;
  state: "pending" | "available" | "no-image";
  createdAtMs?: number;
  lastDemandAtMs?: number | null;
  baseCommit?: string;
  runtimeIdentity?: { nodeBootstrapSha256: string };
  pinned?: { atMs: number };
  previous?: {
    checkpointId: string;
    createdAtMs: number;
    baseCommit?: string;
    pinned?: { atMs: number };
    runtimeIdentity?: { nodeBootstrapSha256: string };
  };
  held: boolean;
  allocationCount: number;
  retirement?: { checkpointId: string };
  capture?: {
    selector: string;
    leaseId?: string;
    phase: "scrubbing" | "creating" | "uncertain";
    stale: boolean;
  };
  recipePreparation?: WorkerRecipePreparation;
  recipePreparationAtMs?: number;
  captureUnsupported?: { atMs: number; provider: string; message: string };
};
export type SnapshotProfile = {
  id: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  warmImages: "on" | "off";
  reason: string;
};
export type SnapshotsResult = {
  images: SnapshotImage[];
  profiles: SnapshotProfile[];
  legacyLeases: { leaseId: string; selector: string; recoveryHint: string }[];
};
export type CloudEnvironment = {
  key: string;
  label: string;
  defaultProfile?: string;
  images: SnapshotImage[];
  workers: EnvironmentSummary[];
};
export function isReadyPreparation(environment: EnvironmentSummary): boolean {
  return (
    environment.status === "available" &&
    environment.worker?.state === "ready" &&
    environment.worker.destroyRequestedAtMs === undefined &&
    environment.preparation?.details?.consumedAtMs === null &&
    environment.preparation.details.expiresAtMs > Date.now() &&
    !environment.worker.attachedSessionIds.length
  );
}
export function preparationNeedsAttention(environment: EnvironmentSummary): boolean {
  return (
    environment.status === "unavailable" ||
    environment.status === "error" ||
    Boolean(environment.worker?.error) ||
    ["failed", "orphaned"].includes(environment.worker?.state ?? "") ||
    (environment.preparation?.details?.expiresAtMs !== undefined &&
      environment.preparation.details.expiresAtMs <= Date.now())
  );
}
export function showPreparationRow(environment: EnvironmentSummary): boolean {
  return Boolean(
    environment.worker &&
    (environment.worker.state !== "ready" ||
      preparationNeedsAttention(environment) ||
      environment.worker.destroyRequestedAtMs !== undefined),
  );
}
export function isUnassignedPreparation(environment: EnvironmentSummary): boolean {
  const worker = environment.worker;
  return Boolean(
    environment.preparation &&
    worker &&
    worker.state !== "destroyed" &&
    !worker.attachedSessionIds.length &&
    (["requested", "provisioning", "bootstrapping", "ready", "failed", "orphaned"].includes(
      worker.state,
    ) ||
      worker.destroyRequestedAtMs !== undefined ||
      worker.error),
  );
}
export function cloudEnvironments(
  images: SnapshotImage[],
  inventory: EnvironmentsListResult | null,
  defaults: CloudWorkerRepository[],
): CloudEnvironment[] {
  const groups = new Map<string, CloudEnvironment>();
  function group(key: string) {
    let entry = groups.get(key);
    if (!entry) {
      entry = { key, label: key, images: [], workers: [] };
      groups.set(key, entry);
    }
    return entry;
  }
  for (const mapping of defaults) {
    group(mapping.repository).defaultProfile = mapping.profileId;
  }
  for (const image of images) {
    if (!image.projectKey && !image.projectLabel && !image.projectRoot) {
      continue;
    }
    const key = image.projectLabel ?? image.projectRoot ?? image.projectKey ?? image.profileKey;
    group(key).images.push(image);
  }
  for (const environment of inventory?.environments ?? []) {
    const label = environment.preparation?.details?.project?.label;
    if (!label || !isUnassignedPreparation(environment)) {
      continue;
    }
    group(label).workers.push(environment);
  }
  return [...groups.values()].toSorted((a, b) => a.label.localeCompare(b.label));
}
export function environmentImage(environment: CloudEnvironment): SnapshotImage | undefined {
  const images = environment.images.toSorted((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  return images.find((image) => image.profileId === environment.defaultProfile) ?? images[0];
}
export function environmentState(
  environment: CloudEnvironment,
): "ready" | "building" | "coldOnly" | "attention" {
  if (
    environment.images.some((image) => snapshotState(image) === "attention") ||
    environment.workers.some(preparationNeedsAttention)
  ) {
    return "attention";
  }
  if (
    environment.images.some((image) => snapshotState(image) === "building") ||
    environment.workers.some((worker) =>
      ["requested", "provisioning", "bootstrapping"].includes(worker.worker?.state ?? ""),
    )
  ) {
    return "building";
  }
  if (
    environment.images.some((image) => image.state === "available") ||
    environment.workers.some(isReadyPreparation)
  ) {
    return "ready";
  }
  return "coldOnly";
}

export function snapshotState(image: SnapshotImage): ReturnType<typeof environmentState> {
  if (
    image.recipePreparation?.failure ||
    image.capture?.phase === "uncertain" ||
    (image.retirement && image.retirement.checkpointId === image.checkpointId)
  ) {
    return "attention";
  }
  return image.capture ? "building" : image.state === "available" ? "ready" : "coldOnly";
}
