import { sessionCreatorProfileId } from "../../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { resolveUserPath } from "../../../utils.js";
import type { ParticipationCeiling } from "../../participation-ceiling.js";
import type { SpawnedToolContext } from "../../spawned-context.js";

/** Shared by the model-facing tool and native callers before reserving or creating anything. */
export function resolveParticipationSpawnError(
  request: {
    runtime?: unknown;
    visible?: unknown;
    thread?: unknown;
    mode?: unknown;
    placement?: unknown;
    projectId?: unknown;
    worktree?: unknown;
    cwd?: unknown;
    agentId?: unknown;
  },
  context: SpawnedToolContext | undefined,
  requesterAgentId: string | undefined,
): string | undefined {
  const ceiling = context?.participationCeiling;
  if (!ceiling) {
    return context?.inheritedToolPolicySource === "participant"
      ? "Participating helpers require their current host-admitted participation ceiling."
      : undefined;
  }
  const placement = request.placement;
  const localPlacement =
    placement === undefined ||
    (typeof placement === "object" &&
      placement !== null &&
      Object.keys(placement).length === 1 &&
      "kind" in placement &&
      placement.kind === "local");
  if (
    (request.runtime !== undefined && request.runtime !== "subagent") ||
    request.visible === true ||
    request.thread === true ||
    request.mode === "session" ||
    !localPlacement
  ) {
    return "Participating inputs may only spawn hidden, Gateway-local OpenClaw helpers without thread binding.";
  }
  const root = ceiling.source?.root ?? context?.sessionPermissionPolicy?.root;
  if (
    !root ||
    !context?.sessionPermissionPolicy ||
    resolveUserPath(context.sessionPermissionPolicy.root) !== resolveUserPath(root) ||
    request.projectId !== undefined ||
    request.worktree === true ||
    (typeof request.cwd === "string" &&
      request.cwd.trim() &&
      resolveUserPath(request.cwd.trim()) !== resolveUserPath(root))
  ) {
    return "Participating helpers must keep the original session root. Omit projectId, worktree, and cwd overrides.";
  }
  if (
    !requesterAgentId ||
    (ceiling.source && ceiling.source.agentId !== requesterAgentId) ||
    (typeof request.agentId === "string" &&
      request.agentId.trim() &&
      normalizeAgentId(request.agentId) !== requesterAgentId)
  ) {
    return "Participating inputs may only spawn helpers of the same agent.";
  }
  return undefined;
}

/** Consume the request owner's worker-prepared row; descendants retain the original source. */
export function captureParticipationSpawnCeiling(params: {
  ceiling: ParticipationCeiling;
  requesterAgentId: string;
  requesterKey: string;
  requesterEntry: SessionEntry | undefined;
  expectedParentSessionId?: string;
  root: string;
}): ParticipationCeiling {
  if (params.ceiling.source) {
    return params.ceiling;
  }
  const entry = params.requesterEntry;
  const creatorProfileId = sessionCreatorProfileId(entry?.createdActor);
  if (
    params.ceiling.sessionKey !== params.requesterKey ||
    !entry?.sessionId ||
    !creatorProfileId ||
    (params.expectedParentSessionId && entry.sessionId !== params.expectedParentSessionId)
  ) {
    throw new Error("Participating spawn requires the original session incarnation and creator.");
  }
  return {
    ...params.ceiling,
    source: {
      agentId: params.requesterAgentId,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision ?? null,
      creatorProfileId,
      root: params.root,
    },
  };
}
