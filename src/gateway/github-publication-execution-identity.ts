import {
  onManagedGitHubProfileChanged,
  GitHubIdentityError,
  resolveConfiguredGitHubToolIdentity,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import { getRepositoryIntegration } from "../plugins/repository-integration-runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import type { GitHubPublicationRequesterSnapshot } from "../state/github-publication-requester.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  currentGitHubPublicationConfig,
} from "./github-publication-availability.js";
import { GitHubPublicationKnownFailure } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { matchesGitHubPublicationIdentityRow } from "./github-publication-receipt.js";
import type { RepositoryCredentialSource } from "./github-user-identity.types.js";

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
  let closed = false;
  const assertAuthority = () => {
    if (closed || !params.validateAuthority()) {
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
  const assertCurrent = () => {
    assertAuthority();
    if (active?.accessExpiresAtMs !== undefined && active.accessExpiresAtMs <= Date.now()) {
      throw new Error(
        "GitHub publication credential expired; refresh the identity before retrying.",
      );
    }
  };
  return {
    assertCurrent,
    async [Symbol.asyncDispose]() {
      closed = true;
      const previous = active;
      active = undefined;
      await previous?.revoke?.();
    },
    refreshIdentity: async (): Promise<PreparedGitHubPublicationIdentity> => {
      assertAuthority();
      const identity = await (params.identity?.prepare() ??
        prepareCurrentGitHubPublicationIdentity(params.row.agent_id));
      let admitted = false;
      try {
        assertAuthority();
        if (!matchesGitHubPublicationIdentityRow(params.row, identity)) {
          throw new Error("GitHub publication identity changed.");
        }
        const previous = active;
        if (identity.accessExpiresAtMs !== undefined && identity.accessExpiresAtMs <= Date.now()) {
          throw new Error("GitHub publication credential expired.");
        }
        active = identity;
        admitted = true;
        if (previous !== identity) {
          await previous?.revoke?.();
        }
        assertCurrent();
        return identity;
      } finally {
        if (!admitted) {
          if (active === identity) {
            active = undefined;
          }
          await identity.revoke?.();
        }
      }
    },
  };
}

/** Original actor and accepted receipt facts accompany every fresh execution grant. */
export async function prepareGitHubPublicationExecutionIdentity(params: {
  row: Pick<
    GitHubPublicationExecutionRow,
    "agent_id" | "session_key" | "session_id" | "request_id" | "request_digest"
  >;
  actor: GitHubPublicationRequesterSnapshot["actor"] | undefined;
  credentialSource?: RepositoryCredentialSource;
  lifecycleRevision: string | null;
  executionKind: "worktree" | "repository";
  ownerId: string;
  assertCurrent: () => void;
}) {
  const { row, actor, assertCurrent } = params;
  const config = currentGitHubPublicationConfig();
  const selected =
    resolveConfiguredGitHubToolIdentity({ config, agentId: row.agent_id, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ config, agentId: row.agent_id, scope: "system" });
  try {
    return await prepareCurrentGitHubPublicationIdentity(
      row.agent_id,
      actor?.kind === "operator"
        ? {
            profileId: actor.profileId,
            credentialSource: params.credentialSource,
            sessionKey: row.session_key,
            assertCurrent,
          }
        : undefined,
      {
        claim: {
          purpose: "publication-execution",
          binding: {
            kind: "publication",
            agentId: row.agent_id,
            sessionKey: row.session_key,
            sessionId: row.session_id,
            lifecycleRevision: params.lifecycleRevision,
            executionKind: params.executionKind,
            requestId: row.request_id,
            ownerId: params.ownerId,
            requestDigest: row.request_digest,
          },
        },
        assertCurrent,
      },
    );
  } catch (error) {
    assertCurrent();
    if (selected?.kind === "app-installation" && getRepositoryIntegration(config)) {
      // Accepted work waits for its original policy owner; auth failure never authorizes replay.
      throw new GitHubPublicationRecoveryPendingError(
        "Repository integration identity is unavailable. Retry from the original signed-in account; accepted work is retained.",
      );
    }
    throw error;
  }
}

/** Credential selection and currency use the same accepted publication agent. */
export function createGitHubPublicationExecutionIdentityOwner(
  readParams: () => Parameters<typeof prepareGitHubPublicationExecutionIdentity>[0],
): GitHubPublicationIdentityOwner {
  return {
    prepare: () => prepareGitHubPublicationExecutionIdentity(readParams()),
    isCurrent: (identity) =>
      matchesCurrentGitHubPublicationIdentity({ agentId: readParams().row.agent_id, identity }),
  };
}
