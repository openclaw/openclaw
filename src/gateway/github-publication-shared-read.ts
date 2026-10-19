import { isDeepStrictEqual } from "node:util";
import { worktreeRegistryPublication } from "../agents/worktrees/registry-publication.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SharedGitHubPublicationReadInput } from "../state/github-publication-read.types.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { repositoryWorkspacePublication } from "../state/session-repository-workspaces.receipts.js";
import {
  prepareGitHubPublicationSession,
  type PublicationSessionIdentity,
} from "./github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "./github-publication-failure.js";

type SharedGitHubPublicationSelector = SharedGitHubPublicationReadInput["selector"];
type SharedObservation = {
  type: "githubPublication.sharedObservation";
  input: SharedGitHubPublicationReadInput;
};
const pendingObservations = new Map<
  string,
  ReturnType<typeof executeExistingOpenClawStateRead<SharedObservation>>
>();
// Publication writes and database replacement must not join an earlier observation.
githubPublicationReceipts.subscribeFacts(() => pendingObservations.clear());
worktreeRegistryPublication.subscribeFacts(() => pendingObservations.clear());
repositoryWorkspacePublication.subscribeFacts(() => pendingObservations.clear());
registerOpenClawStateDatabaseLifecycleListener(() => pendingObservations.clear());

function workspaceSelection(
  entry: Pick<
    SessionEntry,
    "archivedAt" | "repositoryWorkspaceId" | "lifecycleRevision" | "worktree"
  >,
): SharedGitHubPublicationReadInput["entry"] {
  return {
    archivedAt: entry.archivedAt,
    repositoryWorkspaceId: entry.repositoryWorkspaceId,
    lifecycleRevision: entry.lifecycleRevision,
    ...(entry.worktree
      ? {
          worktree: {
            id: entry.worktree.id,
            branch: entry.worktree.branch,
            repoRoot: entry.worktree.repoRoot,
          },
        }
      : {}),
  };
}

/** Observation retains the selected session while the existing-only shared reader runs. */
export async function readSharedGitHubPublication(
  session: PublicationSessionIdentity,
  selector: SharedGitHubPublicationSelector,
  preparedRead?: Awaited<ReturnType<typeof prepareGitHubPublicationSession>>["readCurrent"],
) {
  const capturedSelector = { ...selector };
  let workspaceIndependent = false;
  const memory = captureSessionEntryMetadataRead(session, () => {});
  const context = captureOpenClawStateReadWorkerContext();
  const observe = async (entry: SessionEntry) => {
    const input = { session, selector: capturedSelector, entry: workspaceSelection(entry) };
    // Private actors and maintenance snapshots retain their own read context.
    const key =
      memory || context.maintenanceScope
        ? undefined
        : JSON.stringify([context.admission.identity.key, input]);
    let pending = key ? pendingObservations.get(key) : undefined;
    if (!pending) {
      pending = withArtifactPreservingStateReads(() =>
        executeExistingOpenClawStateRead(
          { path: context.admission.databasePath, env: context.environment },
          { type: "githubPublication.sharedObservation", input },
          { current: true, preferIndependentWarmRead: true, context },
        ),
      );
      if (key) {
        pending = pending.finally(() => {
          if (pendingObservations.get(key) === pending) {
            pendingObservations.delete(key);
          }
        });
        pendingObservations.set(key, pending);
      }
    }
    const result = await pending;
    context.admission.assertCurrent();
    const row = result?.row;
    // Missing or terminal by-id receipts do not qualify the current workspace.
    workspaceIndependent =
      "requestId" in capturedSelector &&
      (!row || row.status === "published" || row.status === "failed");
    return row;
  };
  if (memory) {
    const readCurrent = () => {
      const entry = memory.readCurrent();
      if (
        !entry ||
        entry.sessionId !== session.sessionId ||
        (session.lifecycleRevision !== undefined &&
          (entry.lifecycleRevision ?? null) !== session.lifecycleRevision)
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      return entry;
    };
    const entry = readCurrent();
    const row = await observe(entry);
    const current = readCurrent();
    if (
      !workspaceIndependent &&
      !isDeepStrictEqual(workspaceSelection(entry), workspaceSelection(current))
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
    return row;
  }
  using selected = preparedRead
    ? undefined
    : await prepareGitHubPublicationSession(session.sessionKey, {
        agentId: session.agentId,
        // Terminal receipts retain session authority independently of the current workspace.
        fields: [
          "sessionId",
          "lifecycleRevision",
          "owner",
          "createdActor",
          "visibility",
          "incognito",
        ],
      });
  const readCurrent = preparedRead ?? (() => selected!.readCurrent());
  const loaded = readCurrent();
  const entry = loaded.entry;
  if (
    !entry ||
    loaded.agentId !== session.agentId ||
    loaded.canonicalKey !== session.sessionKey ||
    entry.sessionId !== session.sessionId ||
    (session.lifecycleRevision !== undefined &&
      (entry.lifecycleRevision ?? null) !== session.lifecycleRevision)
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  const row = await observe(entry);
  const current = readCurrent().entry;
  if (
    !current ||
    current.sessionId !== entry.sessionId ||
    current.lifecycleRevision !== entry.lifecycleRevision ||
    (!workspaceIndependent &&
      !isDeepStrictEqual(workspaceSelection(entry), workspaceSelection(current)))
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  return row;
}
