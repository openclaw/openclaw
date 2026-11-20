import {
  onManagedGitHubProfileChanged,
  GitHubIdentityError,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
} from "./github-publication-availability.js";
import { GitHubPublicationKnownFailure } from "./github-publication-failure.js";
import { matchesGitHubPublicationIdentityRow } from "./github-publication-receipt.js";

export class GitHubPublicationAuthorityLostError extends Error {}

export type GitHubPublicationIdentityOwner = {
  prepare: () => Promise<PreparedGitHubPublicationIdentity>;
  isCurrent: (identity: PreparedGitHubPublicationIdentity) => boolean;
};

/** A publication borrows the normal execution identity, never its personal API publisher.
 * Unlike a coding turn, this single transfer has a fixed credential and a bounded lifetime.
 * Rotation/expiry ends this attempt; a later publication prepares a fresh identity.
 */
export async function prepareGitHubPublicationWorkerIdentity(params: {
  agentId: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
}) {
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  let identity: PreparedGitHubPublicationIdentity | undefined;
  const changedProfiles = new Set<string>();
  const changedIdentity = () =>
    new GitHubPublicationKnownFailure("Publication worker GitHub identity changed or expired.", {
      code: "identity_changed",
      nextAction:
        "The worker execution GitHub account changed or expired. Verify its existing connection, then explicitly request publication again. This failed request and checkpoint remain saved; the personal publisher connection is separate.",
    });
  const unavailableIdentity = () =>
    new GitHubPublicationKnownFailure(
      "The normal worker GitHub execution identity is unavailable.",
      {
        code: "identity_unavailable",
        nextAction:
          "Repository publication requires the normal worker GitHub execution account to read the session repository and PR base (one repository unless publishing from a fork). Verify that execution connection and its read access, then explicitly request publication again. My GitHub remains the separate API publisher.",
      },
    );
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.assertCurrent();
    if (
      identity &&
      (!matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity }) ||
        (identity.accessExpiresAtMs !== undefined && identity.accessExpiresAtMs <= Date.now()) ||
        (identity.env.GH_CONFIG_DIR !== undefined &&
          changedProfiles.has(identity.env.GH_CONFIG_DIR)))
    ) {
      throw changedIdentity();
    }
  };
  const changed = () => {
    try {
      assertCurrent();
    } catch (error) {
      controller.abort(error);
    }
  };
  const stops: (() => void)[] = [];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(deadline);
    stops.splice(0).forEach((stop) => stop());
    changedProfiles.clear();
    controller.abort(new Error("Publication worker credential operation closed"));
  };
  try {
    assertCurrent();
    stops.push(
      sessionChanges.subscribe((change) => {
        if (change.scope === "config") {
          changed();
        }
      }),
    );
    identity = await prepareCurrentGitHubPublicationIdentity(params.agentId, assertCurrent, () => {
      stops.push(
        onManagedGitHubProfileChanged(({ profileDir }) => {
          if (!identity) {
            changedProfiles.add(profileDir);
          } else if (profileDir === identity.env.GH_CONFIG_DIR) {
            controller.abort(changedIdentity());
          }
        }),
      );
    });
    assertCurrent();
    if (identity.source === "personal" || !identity.env.GH_TOKEN) {
      throw unavailableIdentity();
    }
    changedProfiles.clear();
    // Match the existing native transfer budget, without extending credential expiry.
    const lifetime = Math.min(10 * 60_000, (identity.accessExpiresAtMs ?? Infinity) - Date.now());
    deadline = setTimeout(
      () => {
        controller.abort(changedIdentity());
      },
      Math.max(0, lifetime),
    );
    deadline.unref();
    assertCurrent();
    return { identity, signal, assertCurrent, release };
  } catch (error) {
    release();
    if (error instanceof GitHubIdentityError) {
      if (error.reason === "rate_limited" || error.reason === "unverified") {
        throw new GitHubPublicationKnownFailure("Worker GitHub verification is unavailable.", {
          code: "unavailable",
          nextAction:
            error.reason === "rate_limited"
              ? "Wait for the GitHub rate limit to clear before retrying publication. The execution account has not been classified as missing."
              : "Retry after the normal worker GitHub execution identity can be verified. An unavailable verification is not proof that repository access was lost.",
        });
      }
      throw error.reason === "changed" ? changedIdentity() : unavailableIdentity();
    }
    throw error;
  }
}

/** Credentials are a fixed snapshot; live workspace, action, and execution owners authorize use. */
export function createGitHubPublicationExecutionIdentity(params: {
  row: Parameters<typeof matchesGitHubPublicationIdentityRow>[0];
  identity?: GitHubPublicationIdentityOwner;
  validateAuthority: () => boolean;
  assertWorkspace: () => void;
}) {
  let active: PreparedGitHubPublicationIdentity | undefined;
  const assertCurrent = () => {
    if (!params.validateAuthority()) {
      throw new GitHubPublicationAuthorityLostError(
        "GitHub publication session authority changed.",
      );
    }
    params.assertWorkspace();
    if (
      active &&
      !(params.identity
        ? params.identity.isCurrent(active)
        : matchesCurrentGitHubPublicationIdentity({
            agentId: params.row.agent_id,
            identity: active,
          }))
    ) {
      throw new Error("GitHub publication identity changed.");
    }
  };
  return {
    assertCurrent,
    refreshIdentity: async (): Promise<PreparedGitHubPublicationIdentity> => {
      assertCurrent();
      const identity = await (params.identity?.prepare() ??
        prepareCurrentGitHubPublicationIdentity(params.row.agent_id));
      assertCurrent();
      if (!matchesGitHubPublicationIdentityRow(params.row, identity)) {
        throw new Error("GitHub publication identity changed.");
      }
      active = identity;
      assertCurrent();
      return identity;
    },
  };
}
