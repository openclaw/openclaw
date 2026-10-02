// Session checkout diff for operator clients, filtered against the exact
// working-tree state captured when the logical session started.
import {
  ErrorCodes,
  errorShape,
  validateSessionsDiffParams,
  type SessionsDiffParams,
  type SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { readRegistryWorktree } from "../../agents/worktrees/registry-read.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { loadCheckoutDiff } from "../../sessions/session-diff.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { loadRepositoryArtifactDiff } from "./session-repository-artifacts.js";
import { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

class SessionDiffAccessError extends Error {}

export async function loadSessionDiff(
  params: SessionsDiffParams,
  context?: GatewayRequestContext,
  access?: { ownWorkspaceOnly: boolean; assertCurrent: () => void },
): Promise<SessionsDiffResult> {
  const empty = (
    unavailableReason?: NonNullable<SessionsDiffResult["unavailableReason"]>,
  ): SessionsDiffResult => ({
    sessionKey: params.sessionKey,
    files: [],
    additions: 0,
    deletions: 0,
    ...(unavailableReason ? { unavailableReason } : {}),
  });
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  const { cfg, agentId, entry, storePath } = loaded;
  // Same session scoping as sessions.files.*: an unknown session must not fall
  // back to some agent workspace and surface another checkout's diff.
  if (!entry?.sessionId || !storePath) {
    return empty("unknown_session");
  }
  const repository = await resolveRepositoryWorkspaceAccess(loaded, context);
  access?.assertCurrent();
  if (repository) {
    if (repository.kind === "stored") {
      const result = await loadRepositoryArtifactDiff(repository, params);
      access?.assertCurrent();
      return result;
    }
    if (!repository.repository.baseCommit) {
      throw new Error("The cloud repository is still preparing its base revision.");
    }
    const result = await repository.inspect(
      "diff",
      {
        scope: params.scope ?? "all",
        commit: params.commit,
        baseCommit: repository.repository.baseCommit,
      },
      access?.assertCurrent,
    );
    // Remote paths are not Gateway-local checkout or native editor destinations.
    delete result.root;
    return result;
  }
  let baseRef: string | undefined;
  let assertWorktreeCurrent: (() => Promise<void>) | undefined;
  if (access?.ownWorkspaceOnly) {
    const registryContext = captureOpenClawStateWorkerContext();
    const worktree = entry.worktree?.id
      ? await readRegistryWorktree(registryContext, entry.worktree.id)
      : undefined;
    access.assertCurrent();
    if (
      !worktree ||
      worktree.removedAt !== undefined ||
      worktree.ownerKind !== "session" ||
      worktree.ownerId !== loaded.canonicalKey ||
      worktree.branch !== entry.worktree?.branch ||
      worktree.repoRoot !== entry.worktree.repoRoot ||
      entry.spawnedCwd !== worktree.path
    ) {
      throw new SessionDiffAccessError(
        "Review requires this session's own managed worktree. Create a new session with a worktree to review its changes.",
      );
    }
    assertWorktreeCurrent = async () => {
      access.assertCurrent();
      const current = await readRegistryWorktree(registryContext, worktree.id);
      access.assertCurrent();
      if (
        !current ||
        current.removedAt !== undefined ||
        current.ownerKind !== "session" ||
        current.ownerId !== loaded.canonicalKey ||
        current.path !== worktree.path ||
        current.branch !== worktree.branch ||
        current.repoRoot !== worktree.repoRoot ||
        current.repoFingerprint !== worktree.repoFingerprint ||
        current.baseRef !== worktree.baseRef
      ) {
        throw new SessionDiffAccessError(
          "The session worktree changed; reopen Review to load its current changes.",
        );
      }
    };
    const identity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
    await assertWorktreeCurrent();
    if (
      identity.checkoutRoot !== worktree.path ||
      identity.repoRoot !== worktree.repoRoot ||
      identity.fingerprint !== worktree.repoFingerprint
    ) {
      throw new SessionDiffAccessError(
        "The session worktree changed; reopen Review to load its current changes.",
      );
    }
    // Registry refs may move. The diff owner resolves their merge base with this
    // checkout's HEAD rather than reading changes from another branch's tip.
    baseRef = worktree.baseRef;
  }
  const { diffCwd: cwd, checkoutPending } = resolveSessionWorkspaceRoots(cfg, agentId, entry);
  if (!cwd) {
    return empty(checkoutPending ? undefined : "unknown_session");
  }
  if (params.scope === "commit") {
    if (!params.commit) {
      throw new TypeError("commit scope requires a commit");
    }
    const result = await loadCheckoutDiff({
      commit: params.commit,
      cwd,
      scope: "commit",
      sessionKey: params.sessionKey,
      baseRef,
    });
    await assertWorktreeCurrent?.();
    return result;
  }
  const result = await loadCheckoutDiff({
    cwd,
    scope: params.scope ?? "all",
    sessionKey: params.sessionKey,
    baseline: entry.sessionDiffBaseline,
    sessionId: entry.sessionId,
    baseRef,
  });
  await assertWorktreeCurrent?.();
  return result;
}

export const sessionsDiffHandlers: GatewayRequestHandlers = {
  "sessions.diff": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateSessionsDiffParams, "sessions.diff", respond)) {
      return;
    }
    const scope = params.scope ?? "all";
    if ((scope === "commit") !== (params.commit !== undefined)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid sessions.diff params: commit must be set if and only if scope is commit",
        ),
      );
      return;
    }
    const requestedAgent = resolveRequestedSessionAgentId(
      context.getRuntimeConfig(),
      params.sessionKey,
      params.agentId,
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const narrow =
      readGatewayRequestMutationAuthority(options).sessionScope === "operator.sessions.read";
    const read = retainSessionScopedRead(options, params.sessionKey, requestedAgent.agentId, {
      requireMaterialized: narrow,
      requireOwner: narrow,
    });
    try {
      const result = await loadSessionDiff(
        {
          ...params,
          ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
        },
        context,
        read ? { ownWorkspaceOnly: narrow, assertCurrent: read.assertCurrent } : undefined,
      );
      read?.assertCurrent();
      if (narrow) {
        delete result.root;
      }
      respond(true, result);
    } catch (error) {
      // Authorization errors retain their hidden-row response; filesystem/worker
      // diagnostics must not expose host paths to a narrow caller.
      read?.assertCurrent();
      if (!narrow) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof SessionDiffAccessError
            ? error.message
            : "The session workspace could not be read. Refresh Review or ask its maintainer to check the workspace.",
        ),
      );
    } finally {
      read?.release();
    }
  },
};
