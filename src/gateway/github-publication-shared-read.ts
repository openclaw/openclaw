import { isDeepStrictEqual } from "node:util";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SharedGitHubPublicationReadInput } from "../state/github-publication-read.types.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { PublicationSessionIdentity } from "./github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "./github-publication-failure.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";

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
  kind: SharedGitHubPublicationReadInput["kind"],
  session: PublicationSessionIdentity,
  selector: SharedGitHubPublicationSelector,
) {
  const capturedSelector = { ...selector };
  let workspaceIndependent = false;
  const binding = captureIncognitoSessionBinding(session);
  const context = binding ? captureOpenClawStateReadWorkerContext() : undefined;
  const observe = async (entry: SessionEntry) => {
    const result = await withArtifactPreservingStateReads(() =>
      executeExistingOpenClawStateRead(
        context ? { path: context.admission.databasePath, env: context.environment } : {},
        {
          type: "githubPublication.sharedObservation",
          input: { kind, session, selector: capturedSelector, entry: workspaceSelection(entry) },
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
  if (binding) {
    const { actor, admissionSignal } = binding;
    const claim = actor.sessions.captureCurrent(session.sessionKey);
    const metadata = captureSessionEntryMetadataRead({ ...session, storePath: actor.path })!;
    const authority = {
      assertCurrent() {
        admissionSignal?.throwIfAborted();
        actor.assertReadable();
        claim.assertCurrent();
        context!.admission.assertCurrent();
      },
    };
    return actor.sessions.withSharedState(async () => {
      const { entry } = await actor.sessions.read(authority, { sessionKey: session.sessionKey });
      if (
        !entry ||
        actor.agentId !== session.agentId ||
        entry.sessionId !== session.sessionId ||
        (session.lifecycleRevision !== undefined &&
          (entry.lifecycleRevision ?? null) !== session.lifecycleRevision)
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      const row = await observe(entry);
      authority.assertCurrent();
      const current = metadata.readCurrent();
      if (
        !current ||
        (!workspaceIndependent &&
          !isDeepStrictEqual(workspaceSelection(entry), workspaceSelection(current)))
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      return row;
    });
  }
  const selected = retainGatewaySessionEntryReadOnly(
    session.sessionKey,
    session.agentId,
    (previous, current) =>
      workspaceIndependent ||
      isDeepStrictEqual(workspaceSelection(previous), workspaceSelection(current)),
  );
  try {
    const entry = selected.entry;
    if (
      !entry ||
      selected.agentId !== session.agentId ||
      selected.canonicalKey !== session.sessionKey ||
      entry.sessionId !== session.sessionId ||
      (session.lifecycleRevision !== undefined &&
        (entry.lifecycleRevision ?? null) !== session.lifecycleRevision)
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
    const row = await observe(entry);
    if (!selected.isCurrentAtResponse()) {
      throw new GitHubPublicationSessionChangedError();
    }
    return row;
  } finally {
    selected.release();
  }
}
