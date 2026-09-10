import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadGatewaySessionEntryReadOnly } from "../../gateway/session-utils.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { maybeAdmitSupervisedRootTask } from "../../tasks/supervised-task.admission.js";
import { bindSupervisedRootSource } from "../../tasks/supervised-task.root-source.js";
import type { RuntimeMsgContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/types.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

/** Runs after normal channel authorization/directives, before backend injection.
 * A durable task receipt, not model execution, takes custody of eligible input. */
export async function maybeAdmitSupervisedChannelTask(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  ctx: RuntimeMsgContext;
  message: string;
  model: string;
  senderIsOwner: boolean;
  spawnedBy?: string;
  options?: InternalGetReplyOptions;
}): Promise<boolean | string> {
  const inputId = readChannelSourceTurnId(params.ctx);
  const options = params.options;
  if (
    !inputId ||
    !params.senderIsOwner ||
    params.spawnedBy ||
    options?.isHeartbeat ||
    (params.ctx.InputProvenance && params.ctx.InputProvenance.kind !== "external_user") ||
    options?.messageInjectionDisposition === "accepted"
  ) {
    return false;
  }
  const assertCurrent = () => {
    options?.abortSignal?.throwIfAborted();
    options?.turnAdoptionLifecycle?.abortSignal?.throwIfAborted();
    options?.replyOperation?.abortSignal.throwIfAborted();
    if (options?.replyOperation?.lifecycleGeneration) {
      assertAgentRunLifecycleGenerationCurrent(options.replyOperation.lifecycleGeneration);
    }
    const current = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
    if (current.entry?.sessionId !== params.sessionId || current.entry.archivedAt !== undefined) {
      throw new Error("Channel task source changed before durable admission");
    }
  };
  const result = await maybeAdmitSupervisedRootTask({
    config: params.config,
    source: bindSupervisedRootSource({ ...params, namespace: "channel", inputId }),
    message: params.message,
    model: params.model,
    ownerAuthorized: true,
    internal: false,
    assertCurrent,
  });
  if (result.kind === "ordinary") {
    return false;
  }
  const state = resolveReplyOperationRunState(options);
  if (state) {
    state.admission = { status: "accepted", mode: "supervised" };
  }
  const lifecycle = { turnAdoptionLifecycle: options?.turnAdoptionLifecycle };
  await admitFollowupRunLifecycle(lifecycle);
  try {
    await options?.userTurnTranscriptRecorder?.persistApproved({
      expectedSessionId: params.sessionId,
      retryIfUnpersisted: true,
    });
  } finally {
    // Finishes only this ingress handoff. The independent task supervisor owns
    // subsequent work and the outbox owns accepted/endpoint announcements.
    completeFollowupRunLifecycle(lifecycle, "consumed");
  }
  return result.kind === "handled" ? result.message : true;
}
