import { isDeepStrictEqual } from "node:util";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SharedGitHubPublicationReadInput } from "../state/github-publication-read.types.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  prepareGitHubPublicationSession,
  type PublicationSessionIdentity,
} from "./github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "./github-publication-failure.js";

type SharedGitHubPublicationSelector = SharedGitHubPublicationReadInput["selector"];

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
) {
  const capturedSelector = { ...selector };
  let workspaceIndependent = false;
  const memory = captureSessionEntryMetadataRead(session, () => {});
  const context = memory ? captureOpenClawStateReadWorkerContext() : undefined;
  const observe = async (entry: SessionEntry) => {
    const result = await withArtifactPreservingStateReads(() =>
      executeExistingOpenClawStateRead(
        context ? { path: context.admission.databasePath, env: context.environment } : {},
        {
          type: "githubPublication.sharedObservation",
          input: { session, selector: capturedSelector, entry: workspaceSelection(entry) },
        },
        { current: true, preferIndependentWarmRead: true, ...(context && { context }) },
      ),
    );
    if (result && (!result.ok || result.type !== "githubPublication.sharedObservation")) {
      throw new Error("Shared GitHub publication observation is unavailable.");
    }
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
    context!.admission.assertCurrent();
    const current = readCurrent();
    if (
      !workspaceIndependent &&
      !isDeepStrictEqual(workspaceSelection(entry), workspaceSelection(current))
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
    return row;
  }
  using selected = await prepareGitHubPublicationSession(session.sessionKey, {
    agentId: session.agentId,
    // Terminal receipts retain session authority independently of the current workspace.
    fields: ["sessionId", "lifecycleRevision", "owner", "createdActor", "visibility", "incognito"],
  });
  const entry = selected.loaded.entry;
  if (
    !entry ||
    selected.loaded.agentId !== session.agentId ||
    selected.loaded.canonicalKey !== session.sessionKey ||
    entry.sessionId !== session.sessionId ||
    (session.lifecycleRevision !== undefined &&
      (entry.lifecycleRevision ?? null) !== session.lifecycleRevision)
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  const row = await observe(entry);
  const current = selected.readCurrent().entry;
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
