import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { normalizeWorkspaceSkillRoots } from "../loading/workspace-skill-roots.js";

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
  changedPath?: string;
  sourceScope?: SkillsSourceScope;
};

export type SkillsSourceScope = {
  executionWorkspaceDir?: string;
  executionWorkspaceFileHost?: "gateway";
};

const listeners = new Set<(event: SkillsChangeEvent) => void>();
const workspaceVersions = new Map<string, number>();
type SourceVersions = {
  workspace: Map<string, number>;
  scopes: Map<string, Map<string, number>>;
};
const discoveryVersions: SourceVersions = { workspace: new Map(), scopes: new Map() };
const supportingFileVersions: SourceVersions = { workspace: new Map(), scopes: new Map() };
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
export function notifySkillsWatchAvailable(params: {
  workspaceDir: string;
  sourceScope: SkillsSourceScope;
}): void {
  emit({ ...params, reason: "watch-available" });
}

function sourceScopeKey(workspaceDir: string, scope: SkillsSourceScope = {}): string {
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: scope.executionWorkspaceDir,
    executionWorkspaceFileHost: scope.executionWorkspaceFileHost,
  });
  // Files in an execution root are shared by every agent and inventory consumer of that root.
  return executionWorkspaceDir
    ? JSON.stringify([executionWorkspaceDir, scope.executionWorkspaceFileHost])
    : "";
}

/** Publish completed discovery facts without doing filesystem work. */
export function bumpSkillsSnapshotVersion(params?: {
  workspaceDir?: string;
  reason?: SkillsChangeEvent["reason"];
  changedPath?: string;
  sourceScopes?: SkillsSourceScope[];
}): number {
  const event: SkillsChangeEvent = {
    workspaceDir: params?.workspaceDir,
    reason: params?.reason ?? "manual",
    changedPath: params?.changedPath,
  };
  sourceClock = bumpVersion(sourceClock);
  if (!params?.workspaceDir) {
    globalSourceVersion = sourceClock;
  } else {
    recordSourceVersion(discoveryVersions, params.workspaceDir, params.sourceScopes);
  }
  return publishChange(event);
}

function recordSourceVersion(
  versions: SourceVersions,
  workspaceDir: string,
  scopes?: SkillsSourceScope[],
): void {
  if (!scopes) {
    versions.workspace.set(workspaceDir, sourceClock);
    return;
  }
  let revisions = versions.scopes.get(workspaceDir);
  if (!revisions) {
    revisions = new Map();
    versions.scopes.set(workspaceDir, revisions);
  }
  for (const scope of scopes) {
    revisions.set(sourceScopeKey(workspaceDir, scope), sourceClock);
  }
}

function readSourceVersion(
  versions: SourceVersions,
  workspaceDir: string,
  scope?: SkillsSourceScope,
): number {
  return Math.max(
    versions.workspace.get(workspaceDir) ?? 0,
    versions.scopes.get(workspaceDir)?.get(sourceScopeKey(workspaceDir, scope)) ?? 0,
  );
}

/** Supporting-file changes refresh copies without rebuilding discovery or publishing snapshots. */
export function markSkillsSupportingFilesChanged(params: {
  workspaceDir: string;
  sourceScopes?: SkillsSourceScope[];
}): void {
  sourceClock = bumpVersion(sourceClock);
  recordSourceVersion(supportingFileVersions, params.workspaceDir, params.sourceScopes);
}

/** Source revisions invalidate discovery and in-flight reads, never consumer generation facts. */
export function getSkillsSourceVersion(workspaceDir: string, scope?: SkillsSourceScope): number {
  return Math.max(globalSourceVersion, readSourceVersion(discoveryVersions, workspaceDir, scope));
}

export function getSkillsResourceVersion(workspaceDir: string, scope?: SkillsSourceScope): number {
  return Math.max(
    getSkillsSourceVersion(workspaceDir, scope),
    readSourceVersion(supportingFileVersions, workspaceDir, scope),
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
  for (const versions of [discoveryVersions, supportingFileVersions]) {
    versions.workspace.clear();
    versions.scopes.clear();
  }
  globalVersion = INITIAL_SKILLS_SNAPSHOT_VERSION;
  versionClock = globalVersion;
  sourceClock = bumpVersion(sourceClock);
  globalSourceVersion = sourceClock;
}
