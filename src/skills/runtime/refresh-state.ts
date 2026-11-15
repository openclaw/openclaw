import { notifyListeners, registerListener } from "../../shared/listeners.js";

type SkillsChangeEvent = {
  workspaceDir?: string;
  reason:
    | "watch"
    | "watch-unavailable"
    | "watch-available"
    | "manual"
    | "remote-node"
    | "config-change"
    | "workshop";
};

const listeners = new Set<(event: SkillsChangeEvent) => void>();
const workspaceVersions = new Map<string, number>();
const discoveryVersions = new Map<string, number>();
const supportingFileVersions = new Map<string, number>();
const INITIAL_SKILLS_SNAPSHOT_VERSION = Date.now();
let versionClock = INITIAL_SKILLS_SNAPSHOT_VERSION;
let globalVersion = INITIAL_SKILLS_SNAPSHOT_VERSION;
let sourceClock = INITIAL_SKILLS_SNAPSHOT_VERSION;
let globalSourceVersion = sourceClock;

function bumpVersion(current: number): number {
  const now = Date.now();
  return now <= current ? current + 1 : now;
}

function emit(event: SkillsChangeEvent) {
  notifyListeners(listeners, event);
}

function publishChange(event: SkillsChangeEvent): number {
  versionClock = bumpVersion(versionClock);
  if (event.workspaceDir) {
    workspaceVersions.set(event.workspaceDir, versionClock);
  } else {
    globalVersion = versionClock;
  }
  emit(event);
  return versionClock;
}

export function registerSkillsChangeListener(listener: (event: SkillsChangeEvent) => void) {
  return registerListener(listeners, listener);
}

/** Coverage recovery follows content reconciliation; it never creates a source revision. */
export function notifySkillsWatchAvailable(params: { workspaceDir: string }): void {
  emit({ ...params, reason: "watch-available" });
}

/** Publish completed discovery facts without doing filesystem work. */
export function bumpSkillsSnapshotVersion(params?: {
  workspaceDir?: string;
  reason?: SkillsChangeEvent["reason"];
}): number {
  const event: SkillsChangeEvent = {
    workspaceDir: params?.workspaceDir,
    reason: params?.reason ?? "manual",
  };
  sourceClock = bumpVersion(sourceClock);
  if (!params?.workspaceDir) {
    globalSourceVersion = sourceClock;
  } else {
    discoveryVersions.set(params.workspaceDir, sourceClock);
  }
  return publishChange(event);
}

/** Supporting-file changes refresh copies without rebuilding discovery or publishing snapshots. */
export function markSkillsSupportingFilesChanged(params: { workspaceDir: string }): void {
  sourceClock = bumpVersion(sourceClock);
  supportingFileVersions.set(params.workspaceDir, sourceClock);
}

/** Source revisions invalidate discovery and in-flight reads, never consumer generation facts. */
export function getSkillsSourceVersion(workspaceDir: string): number {
  return Math.max(globalSourceVersion, discoveryVersions.get(workspaceDir) ?? 0);
}

export function getSkillsResourceVersion(workspaceDir: string): number {
  return Math.max(
    getSkillsSourceVersion(workspaceDir),
    supportingFileVersions.get(workspaceDir) ?? 0,
  );
}

export function getSkillsSnapshotVersion(workspaceDir?: string): number {
  if (!workspaceDir) {
    return globalVersion;
  }
  return Math.max(globalVersion, workspaceVersions.get(workspaceDir) ?? 0);
}

export function shouldRefreshSnapshotForVersion(cached = 0, next = 0): boolean {
  return next === 0 ? cached > 0 : cached < next;
}

export function resetSkillsRefreshStateForTest(): void {
  listeners.clear();
  workspaceVersions.clear();
  discoveryVersions.clear();
  supportingFileVersions.clear();
  globalVersion = INITIAL_SKILLS_SNAPSHOT_VERSION;
  versionClock = globalVersion;
  sourceClock = bumpVersion(sourceClock);
  globalSourceVersion = sourceClock;
}
