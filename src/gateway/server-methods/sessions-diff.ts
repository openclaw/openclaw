// Session checkout diff for operator clients, filtered against the exact
// working-tree state captured when the logical session started.
import { performance } from "node:perf_hooks";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDiffParams,
  type SessionsDiffParams,
  type SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../config/io.js";
import { startDiffReadTiming, type DiffReadTiming } from "../../infra/diff-read-timing.js";
import { loadCheckoutDiff } from "../../sessions/session-diff.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import { startSlowRequestDiagnostics } from "../slow-request-diagnostics.js";
import { sessionFileWorkspaceMatches } from "./session-file-read-authority.js";
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
  diffTiming?: DiffReadTiming,
): Promise<SessionsDiffResult> {
  const resolveStarted = diffTiming ? performance.now() : 0;
  let worktreeCount = 0;
  let returnedFileCount = 0;
  using timing =
    context &&
    startSlowRequestDiagnostics<"resolve" | "repository" | "managedBase" | "git" | "response">(
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
  return await withSessionFileRoot(
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
      timing?.mark("repository");
      using repository = await resolveRepositoryWorkspaceAccess(
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
          summaryOnly: params.summaryOnly,
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
      timing?.mark("managedBase");
      const managedBase = entry.worktree?.id
        ? await (
            await import("../worker-environments/local-workspace-review.js")
          ).readLocalWorkspaceReviewBase({
            agentId,
            sessionKey: loaded.canonicalKey,
            entry,
            cwd,
            assertCurrent,
          })
        : undefined;
      assertCurrent();
      worktreeCount = 1;
      timing?.mark("git");
      if (diffTiming) {
        diffTiming.durations["checkout-resolve"] = performance.now() - resolveStarted;
      }
      const input = {
        cwd,
        sessionKey: params.sessionKey,
        baseCommit: managedBase?.baseCommit,
        summaryOnly: params.summaryOnly,
      };
      let result: SessionsDiffResult;
      if (params.scope === "commit") {
        if (!params.commit) {
          throw new TypeError("commit scope requires a commit");
        }
        result = await loadCheckoutDiff(
          { ...input, commit: params.commit, scope: "commit" },
          diffTiming,
        );
      } else {
        result = await loadCheckoutDiff(
          {
            ...input,
            scope: params.scope ?? "all",
            baseline: entry.sessionDiffBaseline,
            sessionId: entry.sessionId,
          },
          diffTiming,
        );
      }
      assertCurrent();
      managedBase?.assertCurrent();
      returnedFileCount = result.files.length;
      timing?.mark("response");
      return result;
    },
  );
}

export const sessionsDiffHandlers: GatewayRequestHandlers = {
  "sessions.diff": async (options) => {
    const { params, respond, context } = options;
    using ownDiffTiming = options.diffTiming ? undefined : startDiffReadTiming("sessions.diff");
    const diffTiming = options.diffTiming ?? ownDiffTiming;
    const admissionStarted = diffTiming ? performance.now() : 0;
    using timing = startSlowRequestDiagnostics<"scopedRead" | "load" | "send">(
      context.logGateway,
      "slow session diff request",
      "sessions.diff.request",
      "scopedRead",
    );
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
    const read = requestedAgent.agentId
      ? await retainSessionScopedRead(options, params.sessionKey, requestedAgent.agentId, {
          requireMaterialized: true,
          entryMatches: (previous, current) =>
            !hasSessionReadAccessChanged(previous, current) &&
            sessionFileWorkspaceMatches(previous, current),
        })
      : undefined;
    try {
      timing?.mark("load");
      if (diffTiming) {
        diffTiming.durations.admission =
          (diffTiming.durations.admission ?? 0) + performance.now() - admissionStarted;
      }
      const result = await loadSessionDiff(
        {
          ...params,
          ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
        },
        context,
        () => read?.assertCurrent(),
        diffTiming,
      );
      read?.assertCurrent();
      timing?.mark("send");
      const encodeStarted = diffTiming ? performance.now() : 0;
      respond(true, result);
      if (diffTiming) {
        diffTiming.durations.encode = performance.now() - encodeStarted;
      }
    } finally {
      read?.release();
    }
  },
};
