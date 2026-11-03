import type { GitHubPublicationSelectionRejectedErrorDetails } from "../../packages/gateway-protocol/src/gateway-error-details.js";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
export type RepositoryPublicationFailure = Pick<
  Extract<SessionGitHubPublicationResult, { status: "failed" }>,
  "code" | "nextAction"
>;
export class RepositoryPublicationAuthorityLostError extends Error {}
/** An owner observed a definitive failure; probe unavailability is not such a failure. */
class RepositoryPublicationFailureError extends Error {
  constructor(
    message: string,
    readonly failure: RepositoryPublicationFailure,
    readonly rejection?: GitHubPublicationSelectionRejectedErrorDetails,
  ) {
    super(message);
  }
}
// Native SDK imports and source hosts must classify the same definitive failure hierarchy.
const SharedRepositoryPublicationFailureError = resolveGlobalSingleton(
  Symbol.for("openclaw.repositoryPublicationFailureError"),
  () => RepositoryPublicationFailureError,
);
type SharedRepositoryPublicationFailureError = RepositoryPublicationFailureError;
export { SharedRepositoryPublicationFailureError as RepositoryPublicationFailureError };
class RepositoryPublicationRequesterUnavailableError extends SharedRepositoryPublicationFailureError {
  constructor() {
    super("The original GitHub publication requester is no longer authorized.", {
      code: "identity_changed",
      nextAction:
        "Review any recorded or unconfirmed GitHub effects, then request publication again from an authorized session. Saved work and existing pull requests are retained.",
    });
  }
}
const SharedRepositoryPublicationRequesterUnavailableError = resolveGlobalSingleton(
  Symbol.for("openclaw.repositoryPublicationRequesterUnavailableError"),
  () => RepositoryPublicationRequesterUnavailableError,
);
type SharedRepositoryPublicationRequesterUnavailableError =
  RepositoryPublicationRequesterUnavailableError;
export { SharedRepositoryPublicationRequesterUnavailableError as RepositoryPublicationRequesterUnavailableError };
export class RepositoryPublicationChangePermissionError extends SharedRepositoryPublicationFailureError {
  constructor() {
    super("Publishing GitHub workflow changes requires full operator write permission.", {
      code: "github_rejected",
      nextAction:
        "OpenClaw requires the requester's full operator write authority for these workflow changes; this is not a GitHub token scope failure. Your saved changes are intact. Ask a maintainer with full write access to publish, or remove only unintended workflow edits after reviewing the accepted diff.",
    });
  }
}
export class RepositoryPublicationProviderUnavailableError extends Error {
  constructor() {
    super(
      "The repository publisher is unavailable. Re-enable its plugin to resume remote observation or publication. Accepted work and receipts are retained.",
    );
  }
}
