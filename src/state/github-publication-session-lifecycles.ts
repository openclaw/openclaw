import { captureGitHubPublicationLifecycle } from "./github-publication-receipts.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { captureOpenClawStateReadContext } from "./openclaw-state-worker-context.js";

type PublicationIdentity = { publicationKind: "shared" | "personal"; requestId: string };

/** Retain the immutable binding separately from request status and other authority owners. */
export async function prepareGitHubPublicationSessionLifecycle(input: PublicationIdentity) {
  const authority = captureGitHubPublicationLifecycle(captureOpenClawStateReadContext(), input);
  if (!authority.loaded) {
    authority.observe(await readGitHubPublicationSessionLifecycleInWorker(input));
  }
  return { readCurrent: authority.readCurrent };
}

export async function readGitHubPublicationSessionLifecycleInWorker(input: PublicationIdentity) {
  const { publicationKind, requestId } = input;
  const result = await executeExistingOpenClawStateRead(
    {},
    { type: "githubPublication.lifecycle", publicationKind, requestId },
    { current: true },
  );
  if (!result) {
    throw new Error("GitHub publication requester metadata is unavailable.");
  }
  return result.lifecycle;
}
