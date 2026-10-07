import fs from "node:fs";
import path from "node:path";
import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import {
  inspectDatabasePathIdentitySync,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  type OpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import { resolveSessionStorePathCore } from "./paths.js";

export type CapturedSessionStorePaths = ReadonlyMap<
  string,
  { configured: string; default: string }
>;

export function measureSessionStoreTargetInventoryInputBytes(request: {
  paths: CapturedSessionStorePaths;
}): number {
  let bytes = JSON.stringify(request).length * 2;
  // JSON omits Map entries; retain the pool's UTF-16 string charge for captured paths.
  for (const [agentId, paths] of request.paths) {
    bytes += 2 * (agentId.length + paths.configured.length + paths.default.length);
  }
  return bytes;
}

export function resolveCapturedSessionStorePath(
  store: string | undefined,
  agentId: string,
  env: NodeJS.ProcessEnv,
  paths?: CapturedSessionStorePaths,
  kind: "configured" | "default" = "configured",
): string {
  if (!paths) {
    return resolveSessionStorePathCore(kind === "default" ? undefined : store, { agentId, env });
  }
  const captured = paths.get(agentId);
  if (!captured) {
    throw new Error(`Session store path was not captured for ${agentId}`);
  }
  return captured[kind];
}

export type SessionStoreReadCandidate = Pick<
  OpenClawAgentDatabaseReadCandidateResource,
  "path" | "scope"
> & { physicalPath: string };

/** Capture exact candidates before discovery yields; sibling families have no file identity. */
export function captureSessionStoreCandidateIdentities(
  candidates: readonly SessionStoreReadCandidate[],
) {
  return new Map(
    candidates
      .filter((candidate) => !candidate.scope)
      .map((candidate) => {
        const identity = readDatabasePathIdentitySync(candidate.path);
        return [identity.canonicalPath, identity] as const;
      }),
  );
}

/** Families follow their directory; existing file aliases get separate exact captures. */
export function captureSessionStoreReadCandidate(
  pathname: string,
  scope?: "sibling-family",
): SessionStoreReadCandidate {
  const capturedPath = path.resolve(pathname);
  const physicalPath = scope
    ? path.join(
        resolveIdentityPathViaExistingAncestorSync(path.dirname(capturedPath)),
        path.basename(capturedPath),
      )
    : resolveIdentityPathViaExistingAncestorSync(capturedPath);
  return { path: capturedPath, physicalPath, ...(scope ? { scope } : {}) };
}

/** Re-resolve both sides so aliases that converge after file creation remain in custody. */
export function isSessionStoreReadCandidateCurrent(candidate: SessionStoreReadCandidate): boolean {
  const currentPhysicalPath = captureSessionStoreReadCandidate(
    candidate.path,
    candidate.scope,
  ).physicalPath;
  const capturedPhysicalPath = resolveCapturedSessionStoreReadCandidatePhysicalPath(candidate);
  if (currentPhysicalPath === capturedPhysicalPath) {
    return true;
  }
  if (
    candidate.scope ||
    (!isSymlinkFreeWindowsShortPath(candidate.path) &&
      !isSymlinkFreeWindowsShortPath(candidate.physicalPath))
  ) {
    return false;
  }
  return matchesWindowsFileAlias(currentPhysicalPath, capturedPhysicalPath);
}

function resolveCapturedSessionStoreReadCandidatePhysicalPath(
  candidate: SessionStoreReadCandidate,
): string {
  // Family custody is anchored to its captured physical directory. Re-resolving that anchor
  // would accept a directory that was replaced with a symlink after capture.
  if (candidate.scope || !isSymlinkFreeWindowsShortPath(candidate.physicalPath)) {
    return candidate.physicalPath;
  }
  return resolveIdentityPathViaExistingAncestorSync(candidate.physicalPath);
}

function isSymlinkFreeWindowsShortPath(pathname: string): boolean {
  if (process.platform !== "win32" || !/(?:^|[\\/])[^\\/]*~\d+(?=[\\/]|$)/iu.test(pathname)) {
    return false;
  }
  return isSymlinkFreePath(pathname);
}

function isSymlinkFreePath(pathname: string): boolean {
  const resolved = path.resolve(pathname);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) {
      return false;
    }
  }
  return true;
}

function matchesWindowsFileAlias(capturedPath: string, selectedPath: string): boolean {
  const shortPath = isSymlinkFreeWindowsShortPath(capturedPath)
    ? capturedPath
    : isSymlinkFreeWindowsShortPath(selectedPath)
      ? selectedPath
      : undefined;
  if (
    process.platform !== "win32" ||
    !shortPath ||
    !isSymlinkFreePath(capturedPath) ||
    !isSymlinkFreePath(selectedPath)
  ) {
    return false;
  }
  const capturedParent = fs.statSync(path.dirname(capturedPath), { bigint: true });
  const selectedParent = fs.statSync(path.dirname(selectedPath), { bigint: true });
  if (capturedParent.dev !== selectedParent.dev || capturedParent.ino !== selectedParent.ino) {
    return false;
  }
  const capturedIdentity = inspectDatabasePathIdentitySync(capturedPath);
  const selectedIdentity = inspectDatabasePathIdentitySync(selectedPath);
  return (
    capturedIdentity?.key.startsWith("file:") === true &&
    capturedIdentity.key === selectedIdentity?.key &&
    capturedIdentity.birthtime === selectedIdentity.birthtime
  );
}

/** Native discovery may use only the captured lexical and physical family together. */
export function assertSessionStoreReadCandidate(
  pathname: string,
  candidates: readonly SessionStoreReadCandidate[],
): string {
  const physicalPath = resolveIdentityPathViaExistingAncestorSync(pathname);
  for (const candidate of candidates) {
    if (
      (matchesAgentDatabaseReadCandidatePath(candidate, pathname) ||
        (!candidate.scope && matchesWindowsFileAlias(candidate.path, pathname))) &&
      (!candidate.scope ||
        matchesAgentDatabaseReadCandidatePath(
          { ...candidate, path: resolveCapturedSessionStoreReadCandidatePhysicalPath(candidate) },
          physicalPath,
        )) &&
      isSessionStoreReadCandidateCurrent(candidate)
    ) {
      return physicalPath;
    }
  }
  throw new Error(
    `Session database target changed outside captured discovery custody: ${pathname}`,
  );
}
