import type { GitHubPublicationSelectionRejectedErrorDetails } from "../../packages/gateway-protocol/src/gateway-error-details.js";
import type { RepositoryPublicationFailure } from "./repository-publication-contract.js";
export class RepositoryPublicationAuthorityLostError extends Error {}
/** An owner observed a definitive failure; probe unavailability is not such a failure. */
export class RepositoryPublicationFailureError extends Error {
  constructor(
    message: string,
    readonly failure: RepositoryPublicationFailure,
    readonly rejection?: GitHubPublicationSelectionRejectedErrorDetails,
  ) {
    super(message);
  }
}
export class RepositoryPublicationRequesterUnavailableError extends RepositoryPublicationFailureError {
  constructor() {
    super("The original GitHub publication requester is no longer authorized.", {
      code: "identity_changed",
      nextAction:
        "Review any recorded or unconfirmed GitHub effects, then request publication again from an authorized session. Saved work and existing pull requests are retained.",
    });
  }
}
export class RepositoryPublicationChangePermissionError extends RepositoryPublicationFailureError {
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
