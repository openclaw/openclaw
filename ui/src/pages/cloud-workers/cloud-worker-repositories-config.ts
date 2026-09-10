import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeCloudRepo } from "../../../../src/config/cloud-worker-project-profiles.js";

export type CloudWorkerRepository = { repository: string; profileId: string };
type CloudWorkerRepositoryError =
  | "repository"
  | "repositoryExists"
  | "repositoryMissing"
  | "repositoryProfile"
  | "preparedPool";
export type CloudWorkerRepositoryPatch =
  | { patch: Record<string, unknown>; replacePaths: string[] }
  | { error: CloudWorkerRepositoryError };

function cloudWorkerConfig(config: Readonly<Record<string, unknown>> | null) {
  return isRecord(config?.cloudWorkers) ? config.cloudWorkers : {};
}

function repositoryRecords(config: Readonly<Record<string, unknown>>) {
  const cloudWorkers = cloudWorkerConfig(config);
  return isRecord(cloudWorkers.projectProfiles) ? cloudWorkers.projectProfiles : {};
}

export function readCloudWorkerRepositories(
  config: Readonly<Record<string, unknown>> | null,
): CloudWorkerRepository[] {
  return Object.entries(repositoryRecords(config ?? {}))
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

export function buildCloudWorkerRepositoryUpsertPatch(
  config: Readonly<Record<string, unknown>>,
  draft: CloudWorkerRepository,
  original: CloudWorkerRepository | null,
): CloudWorkerRepositoryPatch {
  const repository = normalizeCloudRepo(draft.repository);
  if (!repository || normalizeCloudRepo(`https://${repository}`) !== repository) {
    return { error: "repository" };
  }
  const records = repositoryRecords(config);
  if (original && records[original.repository] !== original.profileId) {
    return { error: "repositoryMissing" };
  }
  if (repository !== original?.repository && Object.hasOwn(records, repository)) {
    return { error: "repositoryExists" };
  }
  const profiles = cloudWorkerConfig(config).profiles;
  if (
    !isRecord(profiles) ||
    !Object.hasOwn(profiles, draft.profileId) ||
    !isRecord(profiles[draft.profileId])
  ) {
    return { error: "repositoryProfile" };
  }
  return {
    patch: {
      cloudWorkers: {
        projectProfiles: {
          ...(original && original.repository !== repository
            ? { [original.repository]: null }
            : {}),
          [repository]: draft.profileId,
        },
      },
    },
    replacePaths: [],
  };
}

export function buildCloudWorkerRepositoryDeletePatch(
  config: Readonly<Record<string, unknown>>,
  original: CloudWorkerRepository,
): CloudWorkerRepositoryPatch {
  if (repositoryRecords(config)[original.repository] !== original.profileId) {
    return { error: "repositoryMissing" };
  }
  return {
    patch: { cloudWorkers: { projectProfiles: { [original.repository]: null } } },
    replacePaths: [],
  };
}
