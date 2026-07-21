// Implements durable managed-flow review handoff without losing session continuity.
import { logVerbose } from "../../globals.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CommandHandler } from "./commands-types.js";

const wrapRuntimeLoader = createLazyImportLoader(() => import("./commands-wrap.runtime.js"));

function loadWrapRuntime(): Promise<typeof import("./commands-wrap.runtime.js")> {
  return wrapRuntimeLoader.load();
}

function statusReply(text: string) {
  return {
    shouldContinue: false as const,
    reply: { text, isStatusNotice: true },
  };
}

export const handleWrapCommand: CommandHandler = async (params) => {
  const body = params.command.commandBodyNormalized;
  if (body !== "/wrap" && !body.startsWith("/wrap ")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /wrap from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const runtime = await loadWrapRuntime();
  const requestedFlowId = body.slice("/wrap".length).trim() || undefined;
  const flow = runtime.resolveWrapReviewFlow({
    ownerKey: params.sessionKey,
    flowId: requestedFlowId,
  });
  if (!flow || flow.syncMode !== "managed") {
    return statusReply(
      requestedFlowId
        ? `⚙️ Review handoff unavailable: managed TaskFlow ${requestedFlowId} was not found.`
        : "⚙️ Review handoff unavailable: no active managed TaskFlow was found for this session.",
    );
  }

  let request;
  try {
    request = runtime.parseTaskReviewRequest(flow);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return statusReply(`⚙️ Review handoff unavailable: ${message}`);
  }

  const sourceTask = runtime.findReviewSourceTask(flow.flowId);
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const result = await runtime.dispatchTaskReview({
    flowId: flow.flowId,
    callerOwnerKey: params.sessionKey,
    request,
    continuity: {
      ownerKey: flow.ownerKey,
      sessionKey: params.sessionKey,
      ...(targetSessionEntry?.sessionId ? { sessionId: targetSessionEntry.sessionId } : {}),
      ...(targetSessionEntry?.compactionCount !== undefined
        ? { compactionCount: targetSessionEntry.compactionCount }
        : {}),
      ...(sourceTask ? { sourceTaskId: sourceTask.taskId } : {}),
    },
    ...(sourceTask ? { parentTaskId: sourceTask.taskId } : {}),
    runtime: runtime.taskReviewerRuntime,
  });
  if (!result.ok) {
    return statusReply(`⚙️ Review handoff unavailable: ${result.reason}`);
  }

  return statusReply(
    [
      result.created ? "Review dispatched." : "Review already dispatched; reusing durable handoff.",
      `State: ${result.detail.state}.`,
      `Commit: ${result.detail.proofBundle.commit}.`,
      `Reviewer: ${result.detail.reviewerAgentId}.`,
      `Task: ${result.task.taskId}.`,
    ].join(" "),
  );
};
