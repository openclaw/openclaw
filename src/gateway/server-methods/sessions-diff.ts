// Session checkout diff for operator clients, filtered against the exact
// working-tree state captured when the logical session started.
import {
  ErrorCodes,
  errorShape,
  validateSessionsDiffParams,
  type SessionsDiffParams,
  type SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadCheckoutDiff } from "../../sessions/session-diff.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { resolveSessionWorkspaceRoots } from "../session-workspace-roots.js";
import { loadRepositoryArtifactDiff } from "./session-repository-artifacts.js";
import { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function loadSessionDiff(
  params: SessionsDiffParams,
  context?: GatewayRequestContext,
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
  if (repository) {
    if (repository.kind === "stored") {
      return await loadRepositoryArtifactDiff(repository, params);
    }
    if (!repository.repository.baseCommit) {
      throw new Error("The cloud repository is still preparing its base revision.");
    }
    const result = await repository.inspect("diff", {
      scope: params.scope ?? "all",
      commit: params.commit,
      baseCommit: repository.repository.baseCommit,
    });
    // Remote paths are not Gateway-local checkout or native editor destinations.
    delete result.root;
    return result;
  }
  const { diffCwd: cwd, checkoutPending } = resolveSessionWorkspaceRoots(cfg, agentId, entry);
  if (!cwd) {
    return empty(checkoutPending ? undefined : "unknown_session");
  }
  if (params.scope === "commit") {
    if (!params.commit) {
      throw new TypeError("commit scope requires a commit");
    }
    return await loadCheckoutDiff({
      commit: params.commit,
      cwd,
      scope: "commit",
      sessionKey: params.sessionKey,
    });
  }
  return await loadCheckoutDiff({
    cwd,
    scope: params.scope ?? "all",
    sessionKey: params.sessionKey,
    baseline: entry.sessionDiffBaseline,
    sessionId: entry.sessionId,
  });
}

export const sessionsDiffHandlers: GatewayRequestHandlers = {
  "sessions.diff": async ({ params, respond, context }) => {
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
    respond(
      true,
      await loadSessionDiff(
        {
          ...params,
          ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
        },
        context,
      ),
    );
  },
};
