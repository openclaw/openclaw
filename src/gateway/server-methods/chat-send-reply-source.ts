import path from "node:path";
import { captureSessionStoreReadCandidates } from "../../config/sessions/session-store-target-inventory.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  matchesAgentDatabaseReadCandidatePath,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";

/** Retire a display reference from committed owner publications, without polling SQLite.
 * This holds no row cache and grants no transcript-read or delivery authority.
 */
export function retainChatSendReplySource(params: {
  agentId: string;
  sessionKey: string;
  storePaths: readonly string[];
  recorder: Pick<UserTurnTranscriptRecorder, "getAdmissionReceipt">;
}) {
  const candidates = params.storePaths.flatMap(captureSessionStoreReadCandidates);
  const paths = new Set(
    [
      ...params.storePaths,
      ...candidates.flatMap(({ path: candidatePath, physicalPath }) => [
        candidatePath,
        physicalPath,
      ]),
    ].map((value) => path.resolve(value)),
  );
  const matchesPath = (pathname: string) =>
    paths.has(path.resolve(pathname)) ||
    candidates.some(
      (candidate) =>
        matchesAgentDatabaseReadCandidatePath(candidate, pathname) ||
        matchesAgentDatabaseReadCandidatePath(
          { ...candidate, path: candidate.physicalPath },
          pathname,
        ),
    );
  let active = true;
  let revoked = false;
  const releases: Array<() => void> = [];
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    for (const stop of releases.splice(0).toReversed()) {
      stop();
    }
  };
  try {
    releases.push(
      sessionChanges.subscribeFacts((change) => {
        if ("all" in change) {
          if (typeof change.scope === "object") {
            if (change.scope.agentId && change.scope.agentId !== params.agentId) {
              return;
            }
            if (change.scope.storePath && !matchesPath(change.scope.storePath)) {
              return;
            }
            revoked = true;
          } else if (
            ![
              "profiles",
              "catalog",
              "acp",
              "agent-runs",
              "worker-placements",
              "worker-environments",
              "config",
            ].includes(change.scope)
          ) {
            revoked = true;
          }
          return;
        }
        if (
          change.scope === "automation" ||
          change.sessionKey !== params.sessionKey ||
          (change.agentId && change.agentId !== params.agentId) ||
          (change.storePath && !matchesPath(change.storePath))
        ) {
          return;
        }
        const source = params.recorder.getAdmissionReceipt();
        // Initialization may choose the SID before any input exists. After commitment,
        // replacement is terminal for this reference, even if old values are restored.
        if (!source) {
          return;
        }
        if (
          change.factsInvalidated ||
          change.facts?.kind === "removed" ||
          (change.facts?.kind === "entry" && change.facts.sessionId !== source.sessionId)
        ) {
          revoked = true;
        }
      }),
    );
    for (const candidate of candidates) {
      for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
        releases.push(
          registerOpenClawAgentDatabaseReadCandidateResource({
            ...candidate,
            path: pathname,
            revoke: release,
            close: async () => release(),
          }),
        );
      }
    }
    return { isCurrent: () => active && !revoked, release };
  } catch (error) {
    release();
    throw error;
  }
}
