import path from "node:path";
import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
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

/** Native discovery may use only the captured lexical and physical family together. */
export function assertSessionStoreReadCandidate(
  pathname: string,
  candidates: readonly SessionStoreReadCandidate[],
): string {
  const physicalPath = resolveIdentityPathViaExistingAncestorSync(pathname);
  for (const candidate of candidates) {
    if (
      matchesAgentDatabaseReadCandidatePath(candidate, pathname) &&
      matchesAgentDatabaseReadCandidatePath(
        { ...candidate, path: candidate.physicalPath },
        physicalPath,
      ) &&
      captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath ===
        candidate.physicalPath
    ) {
      return physicalPath;
    }
  }
  throw new Error(
    `Session database target changed outside captured discovery custody: ${pathname}`,
  );
}
