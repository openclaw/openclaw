import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-record.js";
import { isDirectChatGoalSession } from "./chat-restart-recovery.js";
import type { ChatSendAdmissionParams } from "./chat-send-pre-admission.types.js";
import { isDirectGatewayUserClient } from "./cron-creator-authority-admission.js";

/** Placement input stays pending until setup and the native writer admit it. */
export function isWorkerGoalChatAdmission(
  params: ChatSendAdmissionParams,
  current: { entry?: SessionEntry; canonicalKey: string },
  placement: WorkerSessionPlacementRecord | undefined,
  acpMeta: SessionEntry["acp"] | null,
): boolean {
  const { session, request, context, client } = params;
  return Boolean(
    request.goalOperation &&
    current.entry &&
    isDirectGatewayUserClient(client) &&
    placement?.executionMode === "remote-exec" &&
    placement.state !== "local" &&
    isDirectChatGoalSession({
      entry: current.entry,
      acpMeta,
      requestedSessionId: session.requestedSessionId,
      sessionKey: current.canonicalKey,
    }) &&
    resolveEffectiveAgentRuntime({
      cfg: context.getRuntimeConfig(),
      agentId: session.agentId,
      sessionKey: current.canonicalKey,
      sessionEntry: current.entry,
      provider: session.resolvedSessionModel.provider,
      modelId: session.resolvedSessionModel.model,
    }) === "codex" &&
    getRegisteredAgentHarness("codex")?.harness.cloudPlacement?.mode === "remote-exec",
  );
}
