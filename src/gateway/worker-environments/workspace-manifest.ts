import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isStagedInputPath, stagedInputDirectoriesFromEntries } from "../../media/staged-inputs.js";
import {
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
  MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-inventory-limits.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

export type WorkerWorkspaceManifestEntry =
  | { path: string; type: "file"; mode: number; size: number; sha256: string }
  | { path: string; type: "symlink"; mode: number; target: string };

export type WorkerWorkspaceManifest = {
  version: 1;
  baseCommit: string | null;
  entries: WorkerWorkspaceManifestEntry[];
  directories?: string[];
};

export type WorkerWorkspaceReconciliationJournal = {
  version: 1;
  temporaryNonce: string;
  baseManifestRef: string;
  currentManifestRef: string;
  baseEntries: WorkerWorkspaceManifestEntry[];
  appliedEntries: WorkerWorkspaceManifestEntry[];
  baseDirectories?: string[];
  appliedDirectories?: string[];
  appliedManifestRef?: string;
  baseTree: string;
  basePackSha256: string;
  basePack: Uint8Array;
};

type WorkerWorkspaceReconciliationPlan = Omit<WorkerWorkspaceReconciliationJournal, "basePack">;

export type WorkerWorkspaceReconciliationJournalAdapter = {
  load(): Promise<WorkerWorkspaceReconciliationJournal | undefined>;
  begin(journal: WorkerWorkspaceReconciliationJournal): Promise<void>;
  commit(manifestRef: string): Promise<void>;
  abort(): Promise<void>;
};

// A complete rebase can replace every entry in both valid inventories.
export const MAX_RECONCILIATION_ENTRIES = MAX_WORKSPACE_INVENTORY_ENTRIES * 2;
export const MAX_RECONCILIATION_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_RECONCILIATION_TOTAL_BYTES = 768 * 1024 * 1024;
// Keep the durable SQLite rollback blob bounded independently of raw file bytes.
export const MAX_RECONCILIATION_PACK_BYTES = 256 * 1024 * 1024;
const MANIFEST_REF_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

function manifestPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error("Worker workspace manifest contains an unsafe path");
  }
  return value;
}

function manifestMode(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new Error("Worker workspace manifest contains an invalid mode");
  }
  return value;
}

export function gitFileMode(mode: number): number {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

function compareManifestPaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

type RawManifestEntry =
  | { path: string; type: "directory"; mode: number }
  | WorkerWorkspaceManifestEntry;

function createManifestBudget() {
  let pathBytes = 0;
  let totalBytes = 0;
  return (entry: RawManifestEntry): void => {
    pathBytes += Buffer.byteLength(entry.path);
    totalBytes +=
      entry.type === "file"
        ? entry.size
        : entry.type === "symlink"
          ? Buffer.byteLength(entry.target)
          : 0;
    if (pathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      throw new Error("Worker workspace manifest paths exceed their byte limit");
    }
    if (totalBytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
      throw new Error("Worker workspace manifest exceeds its eligible byte limit");
    }
  };
}

function parseRawEntry(entry: unknown): RawManifestEntry {
  if (!isRecord(entry)) {
    throw new Error("Worker workspace manifest contains an invalid entry");
  }
  const entryPath = manifestPath(entry.path);
  const mode = manifestMode(entry.mode);
  if (entry.type === "directory") {
    return { path: entryPath, type: "directory", mode };
  }
  if (entry.type === "file") {
    if (
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("Worker workspace manifest contains invalid file metadata");
    }
    return {
      path: entryPath,
      type: "file",
      mode: gitFileMode(mode),
      size: entry.size,
      sha256: entry.sha256,
    };
  }
  if (entry.type === "symlink") {
    if (
      typeof entry.target !== "string" ||
      !entry.target ||
      entry.target.includes("\\") ||
      path.posix.isAbsolute(entry.target) ||
      path.win32.parse(entry.target).root !== ""
    ) {
      throw new Error("Worker workspace manifest contains an unsafe symlink");
    }
    const syntheticRoot = "/workspace";
    const resolved = path.posix.resolve(
      path.posix.dirname(`${syntheticRoot}/${entryPath}`),
      entry.target,
    );
    if (resolved !== syntheticRoot && !resolved.startsWith(`${syntheticRoot}/`)) {
      throw new Error("Worker workspace manifest symlink escapes its root");
    }
    return { path: entryPath, type: "symlink", mode: 0o777, target: entry.target };
  }
  throw new Error("Worker workspace manifest contains an unsupported entry type");
}

function validateAndProjectEntries(values: unknown[]): {
  entries: WorkerWorkspaceManifestEntry[];
  directories: string[];
} {
  if (values.length > MAX_WORKSPACE_INVENTORY_ENTRIES) {
    throw new Error("Worker workspace manifest has too many entries");
  }
  const rawEntries = values.map(parseRawEntry);
  const stagedInputs = stagedInputDirectoriesFromEntries(rawEntries);
  let previous = "";
  const recordBudget = createManifestBudget();
  const byPath = new Map<string, RawManifestEntry>();
  for (const entry of rawEntries) {
    if (previous >= entry.path) {
      throw new Error("Worker workspace manifest paths are not unique and sorted");
    }
    for (const ancestor of workspacePathAncestors(entry.path)) {
      if (byPath.get(ancestor)?.type !== "directory") {
        throw new Error("Worker workspace manifest entry has a non-directory parent");
      }
    }
    recordBudget(entry);
    byPath.set(entry.path, entry);
    previous = entry.path;
  }
  const eligible = rawEntries.filter(
    (entry) => !isDerivedWorkspacePath(entry.path, isStagedInputPath(entry.path, stagedInputs)),
  );
  return {
    entries: eligible.filter((entry) => entry.type !== "directory"),
    directories: eligible.filter((entry) => entry.type === "directory").map((entry) => entry.path),
  };
}

export function serializeWorkerWorkspaceManifest(manifest: WorkerWorkspaceManifest): string {
  const stagedInputs = stagedInputDirectoriesFromEntries(manifest.entries);
  const entries = [
    ...(manifest.directories ?? []).map((entryPath) => ({
      path: entryPath,
      type: "directory" as const,
      // Phase 1 projects directory permissions away. Keep recomputed
      // manifests deterministic without creating a new mode contract.
      mode: 0o700,
    })),
    ...manifest.entries,
  ]
    .filter(
      (entry) => !isDerivedWorkspacePath(entry.path, isStagedInputPath(entry.path, stagedInputs)),
    )
    .toSorted(compareManifestPaths);
  if (entries.length > MAX_WORKSPACE_INVENTORY_ENTRIES) {
    throw new Error("Worker workspace manifest has too many entries");
  }
  const recordBudget = createManifestBudget();
  let entryBytes = 0;
  const emptyBytes = Buffer.byteLength(
    JSON.stringify({ version: manifest.version, baseCommit: manifest.baseCommit, entries: [] }),
  );
  for (const entry of entries) {
    entryBytes += Buffer.byteLength(JSON.stringify(entry));
    recordBudget(entry);
    if (emptyBytes + entryBytes + Math.max(0, entries.length - 1) > MAX_WORKSPACE_MANIFEST_BYTES) {
      throw new Error("Worker workspace manifest exceeds the 64 MiB safety limit");
    }
  }
  return JSON.stringify({ version: manifest.version, baseCommit: manifest.baseCommit, entries });
}

export function parseWorkerWorkspaceManifest(
  raw: string,
  expectedRef: string,
): WorkerWorkspaceManifest {
  if (Buffer.byteLength(raw) > MAX_WORKSPACE_MANIFEST_BYTES) {
    throw new Error("Worker workspace manifest exceeds the 64 MiB safety limit");
  }
  const match = MANIFEST_REF_PATTERN.exec(expectedRef);
  if (!match) {
    throw new Error("Worker workspace manifest reference is invalid");
  }
  if (createHash("sha256").update(raw).digest("hex") !== match[1]) {
    throw new Error("Worker workspace manifest digest does not match its reference");
  }
  const manifest: unknown = JSON.parse(raw);
  if (!isRecord(manifest)) {
    throw new Error("Worker workspace manifest is invalid");
  }
  if (
    manifest.version !== 1 ||
    (manifest.baseCommit !== null &&
      (typeof manifest.baseCommit !== "string" || !GIT_COMMIT_PATTERN.test(manifest.baseCommit))) ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error("Worker workspace manifest has an unsupported shape");
  }
  return {
    version: 1,
    baseCommit: manifest.baseCommit,
    ...validateAndProjectEntries(manifest.entries),
  };
}

function parseJournalEntry(value: unknown): WorkerWorkspaceManifestEntry {
  const entry = parseRawEntry(value);
  if (entry.type === "directory") {
    throw new Error("Worker workspace reconciliation journal contains a directory entry");
  }
  return entry;
}

export function serializeWorkerWorkspaceReconciliationPlan(
  journal: WorkerWorkspaceReconciliationJournal,
): string {
  return JSON.stringify({
    version: journal.version,
    temporaryNonce: journal.temporaryNonce,
    baseManifestRef: journal.baseManifestRef,
    currentManifestRef: journal.currentManifestRef,
    baseEntries: journal.baseEntries,
    appliedEntries: journal.appliedEntries,
    baseDirectories: journal.baseDirectories ?? [],
    appliedDirectories: journal.appliedDirectories ?? [],
    appliedManifestRef: journal.appliedManifestRef,
    baseTree: journal.baseTree,
    basePackSha256: journal.basePackSha256,
  } satisfies WorkerWorkspaceReconciliationPlan);
}

export function parseWorkerWorkspaceReconciliationPlan(
  raw: string,
): WorkerWorkspaceReconciliationPlan {
  const plan: unknown = JSON.parse(raw);
  if (!isRecord(plan)) {
    throw new Error("Worker workspace reconciliation journal is invalid");
  }
  // Only absent arrays default to empty; persisted null must still fail validation.
  const {
    baseDirectories: rawBaseDirectories = [],
    appliedDirectories: rawAppliedDirectories = [],
  } = plan;
  if (
    plan.version !== 1 ||
    typeof plan.temporaryNonce !== "string" ||
    !/^[a-f0-9]{32}$/u.test(plan.temporaryNonce) ||
    typeof plan.baseManifestRef !== "string" ||
    !MANIFEST_REF_PATTERN.test(plan.baseManifestRef) ||
    typeof plan.currentManifestRef !== "string" ||
    !MANIFEST_REF_PATTERN.test(plan.currentManifestRef) ||
    typeof plan.baseTree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(plan.baseTree) ||
    typeof plan.basePackSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(plan.basePackSha256) ||
    !Array.isArray(plan.baseEntries) ||
    !Array.isArray(plan.appliedEntries) ||
    !Array.isArray(rawBaseDirectories) ||
    !Array.isArray(rawAppliedDirectories) ||
    (plan.appliedManifestRef !== undefined &&
      (typeof plan.appliedManifestRef !== "string" ||
        !MANIFEST_REF_PATTERN.test(plan.appliedManifestRef))) ||
    plan.baseEntries.length +
      plan.appliedEntries.length +
      rawBaseDirectories.length +
      rawAppliedDirectories.length >
      MAX_RECONCILIATION_ENTRIES
  ) {
    throw new Error("Worker workspace reconciliation journal has an unsupported shape");
  }
  const baseEntries = plan.baseEntries.map(parseJournalEntry);
  const appliedEntries = plan.appliedEntries.map(parseJournalEntry);
  const baseDirectories = rawBaseDirectories.map(manifestPath);
  const appliedDirectories = rawAppliedDirectories.map(manifestPath);
  for (const entries of [baseEntries, appliedEntries]) {
    const paths = entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      throw new Error("Worker workspace reconciliation journal has duplicate paths");
    }
  }
  for (const directories of [baseDirectories, appliedDirectories]) {
    if (new Set(directories).size !== directories.length) {
      throw new Error("Worker workspace reconciliation journal has duplicate directories");
    }
  }
  return {
    version: 1,
    temporaryNonce: plan.temporaryNonce,
    baseManifestRef: plan.baseManifestRef,
    currentManifestRef: plan.currentManifestRef,
    baseEntries,
    appliedEntries,
    baseDirectories,
    appliedDirectories,
    appliedManifestRef: plan.appliedManifestRef,
    baseTree: plan.baseTree,
    basePackSha256: plan.basePackSha256,
  };
}
