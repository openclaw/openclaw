import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readSessionWorkerPlacementAsync,
  type SessionWorkerPlacementContext,
} from "../gateway/worker-environments/session-placement-lifecycle.js";
import { isActiveRemoteExecPlacementForSession } from "../gateway/worker-environments/worker-turn-sandbox.js";
import { resolvePreparedSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";

/** Project saved sandbox policy without preparing a runtime or borrowing viewer authority. */
export async function resolveSessionToolPreviewSandboxPolicy(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionEntry:
    | Pick<SessionEntry, "sessionId" | "sandbox" | "sandboxMode" | "createdActor">
    | undefined;
  context?: SessionWorkerPlacementContext;
}): Promise<SandboxToolPolicy | undefined> {
  const sandbox = resolvePreparedSandboxRuntimeStatus({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    preparedSessionEntry: params.sessionEntry ?? null,
  });
  if (sandbox.sandboxed) {
    return sandbox.toolPolicy;
  }
  const placement = params.context
    ? await readSessionWorkerPlacementAsync({
        context: params.context,
        sessionId: params.sessionEntry?.sessionId,
      })
    : undefined;
  // Remote execution supplies the configured sandbox tools even with local mode off.
  return isActiveRemoteExecPlacementForSession(placement, params) ? sandbox.toolPolicy : undefined;
}
