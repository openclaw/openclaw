import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveActiveEmbeddedRunOwnerForOperation } from "../../agents/embedded-agent-runner/runs.js";
import { getRpcSourceForGateway } from "../../sessions/session-controller.rpc-sources.js";
import {
  activeSessionOperations,
  getSessionControllerEntryForOperation,
} from "../../sessions/session-controller.state.js";
import { projectInFlightRunSnapshot } from "../chat-inflight-snapshot.js";
import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import type { ChatRunState } from "../server-chat-state.js";
import {
  captureGatewayScopeMatcher,
  captureSessionStoreScopeMatcher,
  type SessionRuntimeScope,
} from "../session-runtime-scope.js";
import type { RespondFn } from "./types.js";

export function resolveEmbeddedAgentRunRecoverySnapshot(
  params: SessionRuntimeScope & {
    chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs" | "registry">;
    requestedSessionKey: string;
    canonicalSessionKey: string;
    sessionId?: string;
    agentId?: string;
    defaultAgentId?: string;
  },
) {
  const matchesStore = captureSessionStoreScopeMatcher(params);
  const matchesGateway = captureGatewayScopeMatcher(params.resolveGatewayContext);
  const operations = Array.from(activeSessionOperations()).filter((operation) => {
    const controller = getSessionControllerEntryForOperation(operation);
    const target = controller.target;
    return (
      target !== undefined &&
      controller.attachment?.projectSessionActive !== false &&
      matchesStore(target.storeScope, operation.agentId) &&
      matchesGateway(operation) &&
      !operation.result &&
      (params.sessionId === undefined || operation.sessionId === params.sessionId) &&
      (controller.aliases.has(params.requestedSessionKey) ||
        controller.aliases.has(params.canonicalSessionKey)) &&
      chatRunBelongsToSelectedAgent({
        agentId: operation.agentId,
        sessionKey: operation.key,
        selectedAgentId: params.agentId ?? target.agentId ?? params.defaultAgentId,
        defaultAgentId: params.defaultAgentId,
      })
    );
  });
  const operation = operations.length === 1 ? operations[0] : undefined;
  const target = operation && getSessionControllerEntryForOperation(operation).target;
  if (!operation || !target) {
    return undefined;
  }
  const owner = resolveActiveEmbeddedRunOwnerForOperation(operation);
  if (!owner) {
    return undefined;
  }
  // Queued execution has its own runtime ID; history must retain the client
  // identity used by its live events and final reply.
  const registration = params.chatRunState.registry.peek(owner.runId);
  const source =
    registration &&
    getRpcSourceForGateway(registration.clientRunId, params.resolveGatewayContext, target);
  const runId =
    registration &&
    source?.input.claim?.operation === operation &&
    (registration.sessionKey === params.requestedSessionKey ||
      registration.sessionKey === params.canonicalSessionKey) &&
    chatRunBelongsToSelectedAgent({
      agentId: registration.agentId,
      sessionKey: registration.sessionKey,
      selectedAgentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
    })
      ? registration.clientRunId
      : owner.runId;
  return projectInFlightRunSnapshot({
    chatRunState: params.chatRunState,
    runId,
    startedAtMs: owner.startedAtMs,
    sessionAbortable: true,
  });
}

export type ChatHistoryMethod =
  | "chat.history"
  | "chat.startup"
  | "chat.message.get"
  | "chat.predict"
  | "chat.pendingInputs.dismiss";

export function respondChatHistoryUnavailable(
  method: ChatHistoryMethod,
  respond: RespondFn,
  message: string,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: { method },
      retryable: true,
      retryAfterMs: 250,
    }),
  );
}
