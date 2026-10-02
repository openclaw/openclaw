import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
  isSessionStoreReadCandidateCurrent,
} from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { matchesAgentDatabaseReadCandidatePath } from "../state/openclaw-agent-db-resources.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";

/** Capture the complete selector family before resolving its physical owner. */
export function captureSessionSharingStore(
  target: Pick<SessionSharingTarget, "agentId" | "storePath" | "readSource">,
  env: NodeJS.ProcessEnv,
  assertCallerCurrent: () => void,
) {
  const candidates = captureSessionStoreReadCandidates(target.storePath);
  const { agentId, storePath, readSource } = target;
  if (readSource) {
    const known = captureSessionStoreReadCandidate(readSource.path);
    if (
      !candidates.some((candidate) =>
        matchesAgentDatabaseReadCandidatePath(
          { ...candidate, path: candidate.physicalPath },
          known.physicalPath,
        ),
      )
    ) {
      throw new Error("Session sharing source changed");
    }
    // Listing may fail even while the admitted exact file remains accessible.
    candidates.push(known);
  }
  const identities = captureSessionStoreCandidateIdentities(candidates);
  return async () => {
    assertCallerCurrent();
    const resolved =
      readSource ?? (await prepareSqliteTargetFromSessionStorePath(storePath, { agentId, env }));
    const assertSourcePathCurrent = () => {
      if (!candidates.every(isSessionStoreReadCandidateCurrent)) {
        throw new Error("Session sharing source changed");
      }
      try {
        return assertSessionStoreReadCandidate(resolved.path, candidates);
      } catch (cause) {
        throw new Error("Session sharing source changed", { cause });
      }
    };
    const pathname = assertSourcePathCurrent();
    const identity = identities.get(pathname);
    if (!resolved.agentId || !identity?.key.startsWith("file:")) {
      throw new Error("Session sharing source is unavailable");
    }
    const source: CapturedSessionEntryReadSource = readSource ?? {
      agentId: resolved.agentId,
      path: pathname,
      databaseIdentity: identity.key.slice("file:".length),
      databaseBirthtime: identity.birthtime,
    };
    const databaseIdentity = source.databaseIdentity;
    if (typeof databaseIdentity !== "string") {
      throw new Error("Session sharing reader requires a file-backed source");
    }
    const assertCurrent = () => {
      assertSourcePathCurrent();
      assertExistingDatabaseIdentity(pathname, identity.key, identity.birthtime);
      assertExistingDatabaseIdentity(
        source.path,
        `file:${databaseIdentity}`,
        source.databaseBirthtime,
      );
    };
    assertCallerCurrent();
    assertCurrent();
    return { source, assertCurrent };
  };
}
