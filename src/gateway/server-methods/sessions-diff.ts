// Session checkout diff for operator clients, filtered against the exact
// working-tree state captured when the logical session started.
import {
  ErrorCodes,
  errorShape,
  validateSessionsDiffParams,
  type SessionsDiffParams,
  type SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../config/io.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { loadCheckoutDiff } from "../../sessions/session-diff.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { startSlowRequestDiagnostics } from "../slow-request-diagnostics.js";
import { loadRepositoryArtifactDiff } from "./session-repository-artifacts.js";
import { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import { withSessionFileRoot } from "./sessions-files.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function loadSessionDiff(
  params: SessionsDiffParams,
  context?: GatewayRequestContext,
  assertAuthorized: () => void = () => {},
): Promise<SessionsDiffResult> {
  let worktreeCount = 0;
  let returnedFileCount = 0;
  using timing =
    context &&
    startSlowRequestDiagnostics<"resolve" | "git" | "response">(
      context.logGateway,
      "slow session checkout diff",
      "sessions.diff",
      "resolve",
      () => ({ worktreeCount, returnedFileCount, scope: params.scope ?? "all" }),
    );
  const empty = (
    unavailableReason?: NonNullable<SessionsDiffResult["unavailableReason"]>,
  ): SessionsDiffResult => ({
    sessionKey: params.sessionKey,
    files: [],
    additions: 0,
    deletions: 0,
    ...(unavailableReason ? { unavailableReason } : {}),
  });
  return withSessionFileRoot(
    { ...params, projection: ["sessionDiffBaseline"] },
    context?.getRuntimeConfig() ?? getRuntimeConfig(),
    async (loaded, assertSourceCurrent) => {
      const { agentId, entry, storePath } = loaded;
      const assertCurrent = () => {
        assertSourceCurrent();
        assertAuthorized();
      };
      assertCurrent();
      // Same session scoping as sessions.files.*: an unknown session must not fall
      // back to some agent workspace and surface another checkout's diff.
      if (!entry?.sessionId || !storePath || !agentId) {
        return empty("unknown_session");
      }
      const repository = await resolveRepositoryWorkspaceAccess(
        { ...loaded, agentId },
        context,
        assertCurrent,
      );
      assertCurrent();
      if (repository) {
        if (repository.kind === "stored") {
          const result = await loadRepositoryArtifactDiff(repository, params);
          assertCurrent();
          return result;
        }
        if (!repository.repository.baseCommit) {
          throw new Error("The cloud repository is still preparing its base revision.");
        }
        const result = await repository.inspect("diff", {
          scope: params.scope ?? "all",
          commit: params.commit,
          baseCommit: repository.repository.baseCommit,
        });
        assertCurrent();
        // Remote paths are not Gateway-local checkout or native editor destinations.
        delete result.root;
        return result;
      }
      const cwd = loaded.diffCwd;
      const checkoutPending = Boolean(entry.pendingWorktree || entry.pendingProjectGitUrl);
      if (!cwd) {
        return empty(checkoutPending ? undefined : "unknown_session");
      }
      worktreeCount = 1;
      timing?.mark("git");
      const input = { cwd, sessionKey: params.sessionKey };
      let result: SessionsDiffResult;
      if (params.scope === "commit") {
        if (!params.commit) {
          throw new TypeError("commit scope requires a commit");
        }
        result = await loadCheckoutDiff({ ...input, commit: params.commit, scope: "commit" });
      } else {
        result = await loadCheckoutDiff({
          ...input,
          scope: params.scope ?? "all",
          baseline: entry.sessionDiffBaseline,
          sessionId: entry.sessionId,
        });
      }
      assertCurrent();
      returnedFileCount = result.files.length;
      timing?.mark("response");
      return result;
    },
  );
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
    const read =
      requestedAgent.agentId && isIncognitoSessionKey(params.sessionKey)
        ? retainSessionScopedRead(options, params.sessionKey, requestedAgent.agentId, {
            requireMaterialized: true,
          })
        : undefined;
    try {
      const result = await loadSessionDiff(
        {
          ...params,
          ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
        },
        context,
        () => read?.assertCurrent(),
      );
      read?.assertCurrent();
      respond(true, result);
    } finally {
      read?.release();
    }
  },
};
