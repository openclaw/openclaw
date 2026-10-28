import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionControllerInput } from "../../sessions/session-controller.contracts.js";
import {
  getSessionControllerSourceIdentity,
  isLiveSessionControllerSource,
} from "../../sessions/session-controller.identity.js";
import type { InternalAgentTurnDispatchOptions } from "../agent-turn/internal-facade.types.js";
import { readChatInputRecoveryAdmission } from "../chat-input-recovery-source.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  readSessionSharingStringParam,
  resolveChatSendAuthorizationParams,
} from "../session-sharing-target-input.js";

/** Only exact saved input or a live reserved source may pass its agent's recovery gate. */
export function isGatewayRecoveryInput(
  params: {
    method: string;
    requestParams: unknown;
    recoveryInput?: InternalAgentTurnDispatchOptions["recoveryInput"];
    controllerInput?: SessionControllerInput;
  },
  cfg: OpenClawConfig,
): boolean {
  if (params.method !== "chat.send" && params.method !== "agent") {
    return false;
  }
  const normalized =
    params.method === "chat.send"
      ? resolveChatSendAuthorizationParams(cfg, params.requestParams)
      : { ok: true as const, value: params.requestParams };
  if (!normalized.ok || !isRecord(normalized.value)) {
    return false;
  }
  const request = normalized.value;
  const sessionKey = readSessionSharingStringParam(request, "sessionKey");
  const runId = readSessionSharingStringParam(request, "idempotencyKey");
  const selected = resolveRequestedSessionAgentId(
    cfg,
    sessionKey,
    readSessionSharingStringParam(request, "agentId"),
  );
  if (!selected.ok || !sessionKey || !runId) {
    return false;
  }
  if (params.method === "chat.send") {
    const saved = readChatInputRecoveryAdmission(runId);
    return saved?.target.agentId === selected.agentId && saved.target.sessionKey === sessionKey;
  }
  const sessionId = readSessionSharingStringParam(request, "expectedExistingSessionId");
  const saved = params.recoveryInput;
  if (
    saved?.agentId === selected.agentId &&
    saved.sessionKey === sessionKey &&
    saved.sessionId === sessionId &&
    saved.runId === runId
  ) {
    saved.assertCurrent();
    return true;
  }
  const input = params.controllerInput;
  if (!input || !isLiveSessionControllerSource(input)) {
    return false;
  }
  const identity = getSessionControllerSourceIdentity(input);
  if (
    identity.agentId !== selected.agentId ||
    identity.sessionKey !== sessionKey ||
    (sessionId !== undefined && identity.sessionId !== sessionId) ||
    (input.protocolRunId !== undefined && input.protocolRunId !== runId)
  ) {
    return false;
  }
  input.sourceAdapter?.authority?.assertCurrent();
  return true;
}
