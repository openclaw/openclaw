import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeCloudRepo } from "../../../../src/config/cloud-worker-project-profiles.js";

export type CloudWorkerRepository = { repository: string; profileId: string };
type CloudWorkerRepositoryError = "repository" | "repositoryProfile" | "preparedPool";
export type CloudWorkerRepositoryPatch =
  | { patch: Record<string, unknown>; replacePaths: string[] }
  | { error: CloudWorkerRepositoryError };

function cloudWorkerConfig(config: Readonly<Record<string, unknown>> | null) {
  return isRecord(config?.cloudWorkers) ? config.cloudWorkers : {};
}

export function readCloudWorkerRepositories(
  config: Readonly<Record<string, unknown>> | null,
): CloudWorkerRepository[] {
  const cloudWorkers = cloudWorkerConfig(config ?? {});
  const profiles = isRecord(cloudWorkers.projectProfiles) ? cloudWorkers.projectProfiles : {};
  return Object.entries(profiles)
    .flatMap(([repository, profileId]) =>
      typeof profileId === "string" ? [{ repository, profileId }] : [],
    )
    .toSorted((left, right) => left.repository.localeCompare(right.repository));
}

export function readCloudWorkerPreparedPool(config: Readonly<Record<string, unknown>> | null) {
  const cloudWorkers = cloudWorkerConfig(config);
  const pool = isRecord(cloudWorkers.preparedPool) ? cloudWorkers.preparedPool : {};
  return typeof pool.maxTotal === "number" ? String(pool.maxTotal) : "";
}

export function buildCloudWorkerPreparedPoolPatch(maxTotal: string): CloudWorkerRepositoryPatch {
  const value = maxTotal.trim();
  if (value && (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))) {
    return { error: "preparedPool" };
  }
  return {
    patch: { cloudWorkers: { preparedPool: { maxTotal: value ? Number(value) : null } } },
    replacePaths: [],
  };
}

export function buildCloudWorkerRepositoryProfilePatch(
  config: Readonly<Record<string, unknown>>,
  repositoryInput: string,
  profileId: string,
): CloudWorkerRepositoryPatch {
  const repository = normalizeCloudRepo(repositoryInput);
  if (!repository || normalizeCloudRepo(`https://${repository}`) !== repository) {
    return { error: "repository" };
  }
  const profiles = cloudWorkerConfig(config).profiles;
  if (
    !isRecord(profiles) ||
    !Object.hasOwn(profiles, profileId) ||
    !isRecord(profiles[profileId])
  ) {
    return { error: "repositoryProfile" };
  }
  return {
    patch: { cloudWorkers: { projectProfiles: { [repository]: profileId } } },
    replacePaths: [],
  };
}
