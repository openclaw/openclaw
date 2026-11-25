import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { resolveUserPath } from "../../../utils.js";
import type { SpawnedToolContext } from "../../spawned-context.js";
import { resolveGatewayToolOperatorSelection } from "../../tools/gateway-caller-context.js";

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
  const authority =
    resolveGatewayToolOperatorSelection().operatorAuthority ??
    getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
  const ceiling = authority?.participationCeiling;
  if (!ceiling) {
    return undefined;
  }
  authority.signal?.throwIfAborted();
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
  const root = ceiling.source.root;
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
    ceiling.source.agentId !== requesterAgentId ||
    (typeof request.agentId === "string" &&
      request.agentId.trim() &&
      normalizeAgentId(request.agentId) !== requesterAgentId)
  ) {
    return "Participating inputs may only spawn helpers of the same agent.";
  }
  return undefined;
}
