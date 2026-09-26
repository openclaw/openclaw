import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { Skill } from "../loading/skill-contract.js";
import { normalizeWorkspaceSkillRoots } from "../loading/workspace-skill-roots.js";

// Skill refresh state types describe change notifications emitted by runtime reloads.
type SkillsChangeEvent = {
  workspaceDir?: string;
  reason:
    | "watch"
    | "watch-targets"
    | "watch-unavailable"
    | "watch-available"
    | "manual"
    | "remote-node"
    | "config-change"
    | "workshop";
  changedPath?: string;
  sourceScope?: SkillsSourceScope;
};

export type SkillsSourceScope = { executionWorkspaceDir?: string };
export type SkillsSourceRefreshInputs = {
  sourceScope: SkillsSourceScope;
  config?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

type SkillsSnapshotSource = {
  scopeKey: string;
  fingerprint: string;
  reconcile: (inputs?: SkillsSourceRefreshInputs) => string;
  suspend: () => void;
  suspended?: boolean;
};
const listeners = new Set<(event: SkillsChangeEvent) => void>();
const workspaceVersions = new Map<string, number>();
type SourceVersions = {
  workspace: Map<string, number>;
  scopes: Map<string, Map<string, number>>;
};
const discoveryVersions: SourceVersions = { workspace: new Map(), scopes: new Map() };
const supportingFileVersions: SourceVersions = { workspace: new Map(), scopes: new Map() };
// Fingerprints survive entry-cache eviction; this owner retains no parsed skill entries.
const workspaceSources = new Map<string, Map<string, SkillsSnapshotSource>>();
const reconcilingWorkspaces = new Set<string>();
const INITIAL_SKILLS_SNAPSHOT_VERSION = Date.now();
let versionClock = INITIAL_SKILLS_SNAPSHOT_VERSION;
let globalVersion = INITIAL_SKILLS_SNAPSHOT_VERSION;
let sourceClock = INITIAL_SKILLS_SNAPSHOT_VERSION;
let globalSourceVersion = sourceClock;
let listenerErrorHandler: ((err: unknown) => void) | undefined;

function bumpVersion(current: number): number {
  const now = Date.now();
  return now <= current ? current + 1 : now;
}

function emit(event: SkillsChangeEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      listenerErrorHandler?.(err);
    }
  }
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

export function setSkillsChangeListenerErrorHandler(handler?: (err: unknown) => void): void {
  listenerErrorHandler = handler;
}

export function registerSkillsChangeListener(listener: (event: SkillsChangeEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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
  });
  // Files in an execution root are shared by every agent and inventory consumer of that root.
  return executionWorkspaceDir ?? "";
}

/** Record resolved file-backed winners at the discovery boundary, before session filtering. */
export function observeSkillsSnapshotSource(params: {
  workspaceDir: string;
  sourceKey: string;
  sourceScope: SkillsSourceScope;
  entries: readonly { skill: Skill; skillKey: string }[];
  reconcile: (inputs?: SkillsSourceRefreshInputs) => string;
  suspend: () => void;
}): void {
  const fingerprint = sha256Hex(
    JSON.stringify(
      params.entries.map(({ skill, skillKey }) => [
        skill.name,
        skillKey,
        skill.source,
        skill.filePath,
        skill.contentHash,
      ]),
    ),
  );
  let sources = workspaceSources.get(params.workspaceDir);
  if (!sources) {
    sources = new Map();
    workspaceSources.set(params.workspaceDir, sources);
  }
  const previous = sources.get(params.sourceKey);
  sources.set(params.sourceKey, {
    scopeKey: sourceScopeKey(params.workspaceDir, params.sourceScope),
    fingerprint,
    reconcile: params.reconcile,
    suspend: params.suspend,
  });
  // A cache eviction or a new configuration can expose changed content without a watch event.
  if (
    previous &&
    previous.fingerprint !== fingerprint &&
    !reconcilingWorkspaces.has(params.workspaceDir)
  ) {
    publishChange({ workspaceDir: params.workspaceDir, reason: "manual" });
  }
}

export function suspendSkillsSnapshotSources(workspaceDir: string, scope: SkillsSourceScope): void {
  const key = sourceScopeKey(workspaceDir, scope);
  for (const source of workspaceSources.get(workspaceDir)?.values() ?? []) {
    if (source.scopeKey === key) {
      source.suspend();
      source.suspended = true;
    }
  }
}

function reconcileWorkspaceSources(
  workspaceDir: string,
  scopes?: SkillsSourceScope[],
  inputs?: SkillsSourceRefreshInputs,
): boolean {
  const sources = workspaceSources.get(workspaceDir);
  if (!sources?.size) {
    return true;
  }
  const selectedScopes =
    scopes && new Set(scopes.map((scope) => sourceScopeKey(workspaceDir, scope)));
  let changed = false;
  reconcilingWorkspaces.add(workspaceDir);
  try {
    for (const [key, previous] of Array.from(sources)) {
      if (selectedScopes && !selectedScopes.has(previous.scopeKey)) {
        continue;
      }
      if (
        previous.suspended &&
        (!inputs ||
          (previous.scopeKey !== "" &&
            previous.scopeKey !== sourceScopeKey(workspaceDir, inputs.sourceScope)))
      ) {
        continue;
      }
      const nextKey = previous.reconcile(inputs);
      changed ||= sources.get(nextKey)?.fingerprint !== previous.fingerprint;
      if (nextKey !== key) {
        sources.delete(key);
      }
    }
  } catch (error) {
    // Leave caches invalidated so preparation can retry a failed reconciliation.
    listenerErrorHandler?.(error);
    changed = true;
  } finally {
    reconcilingWorkspaces.delete(workspaceDir);
  }
  return changed;
}

export function bumpSkillsSnapshotVersion(params?: {
  workspaceDir?: string;
  reason?: SkillsChangeEvent["reason"];
  changedPath?: string;
  sourceScopes?: SkillsSourceScope[];
  refreshInputs?: SkillsSourceRefreshInputs;
}): number {
  const event: SkillsChangeEvent = {
    workspaceDir: params?.workspaceDir,
    reason: params?.reason ?? "manual",
    changedPath: params?.changedPath,
  };
  // Availability is an owner fact even when the last content fingerprint is
  // unchanged; remote subscribers need it to reconcile later preparations.
  const semanticChange =
    event.reason === "config-change" ||
    event.reason === "remote-node" ||
    event.reason === "watch-unavailable";
  sourceClock = bumpVersion(sourceClock);
  if (!params?.workspaceDir) {
    globalSourceVersion = sourceClock;
    if (semanticChange || workspaceSources.size === 0) {
      return publishChange(event);
    }
    for (const workspaceDir of workspaceSources.keys()) {
      if (reconcileWorkspaceSources(workspaceDir)) {
        publishChange({ ...event, workspaceDir });
      }
    }
    return getSkillsSnapshotVersion();
  }
  const workspaceDir = params.workspaceDir;
  recordSourceVersion(discoveryVersions, workspaceDir, params.sourceScopes);
  if (
    !semanticChange &&
    !reconcileWorkspaceSources(workspaceDir, params.sourceScopes, params.refreshInputs)
  ) {
    return getSkillsSnapshotVersion(workspaceDir);
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

export function shouldRefreshSnapshotForVersion(
  cachedVersion?: number,
  nextVersion?: number,
): boolean {
  const cached = typeof cachedVersion === "number" ? cachedVersion : 0;
  const next = typeof nextVersion === "number" ? nextVersion : 0;
  return next === 0 ? cached > 0 : cached < next;
}

export function resetSkillsRefreshStateForTest(): void {
  listeners.clear();
  workspaceVersions.clear();
  for (const versions of [discoveryVersions, supportingFileVersions]) {
    versions.workspace.clear();
    versions.scopes.clear();
  }
  workspaceSources.clear();
  reconcilingWorkspaces.clear();
  globalVersion = INITIAL_SKILLS_SNAPSHOT_VERSION;
  versionClock = globalVersion;
  sourceClock = bumpVersion(sourceClock);
  globalSourceVersion = sourceClock;
  listenerErrorHandler = undefined;
}
