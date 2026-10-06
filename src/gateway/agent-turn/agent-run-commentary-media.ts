import type { WebchatReplyMediaRequesterContext } from "../server-methods/chat-reply-media.js";
import { resolveChatSendCallerContext } from "../server-methods/gateway-client-identity.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/** Bind progress media to the agent command, before dispatch releases its run owner. */
export function dispatchAgentRunWithCommentaryMedia(
  dispatch: Parameters<typeof dispatchAgentRunFromGateway>[0],
  params: Pick<StartAgentRunExecutionParams, "cfg" | "client" | "activeSessionAgentId">,
) {
  const { ingressOpts, admittedRunEntry, abortController } = dispatch;
  const sessionKey = ingressOpts.sessionKey;
  if (!sessionKey) {
    return dispatchAgentRunFromGateway(dispatch);
  }
  const caller: WebchatReplyMediaRequesterContext | undefined = params.client
    ? resolveChatSendCallerContext(params.client)
    : undefined;
  const runContext = ingressOpts.runContext;
  // Preserve the dispatch object's execution-identity binding.
  dispatch.loadCommentaryMedia = async () => {
    const { createAssistantCommentaryMediaCustody } =
      await import("../server-methods/chat-send-commentary-media.js");
    return createAssistantCommentaryMediaCustody({
      session: {
        agentId: params.activeSessionAgentId,
        cfg: dispatch.commandRuntimeContext?.config ?? params.cfg,
        sessionKey,
        sessionLoadOptions: { agentId: params.activeSessionAgentId },
      },
      requesterContext: {
        ...caller,
        SenderId: runContext?.senderId ?? caller?.SenderId,
        GroupChannel: runContext?.groupChannel ?? ingressOpts.groupChannel ?? caller?.GroupChannel,
        GroupSpace: runContext?.groupSpace ?? ingressOpts.groupSpace ?? caller?.GroupSpace,
        Provider: runContext?.messageChannel ?? ingressOpts.messageChannel ?? caller?.Provider,
        Surface: runContext?.messageChannel ?? ingressOpts.messageChannel ?? caller?.Surface,
      },
      accountId: ingressOpts.accountId,
      getRunId: () => dispatch.runId,
      isCurrent: () => {
        try {
          dispatch.assertCurrent?.();
          return (
            Boolean(admittedRunEntry) &&
            dispatch.context.chatAbortControllers.get(dispatch.runId) === admittedRunEntry &&
            admittedRunEntry?.controller === abortController &&
            !admittedRunEntry.registrationCleanupRequested &&
            !abortController.signal.aborted
          );
        } catch {
          return false;
        }
      },
      abortSignal: abortController.signal,
      logGateway: dispatch.context.logGateway,
      prepareAssistantTranscriptMessage: ingressOpts.prepareAssistantTranscriptMessage,
    });
  };
  return dispatchAgentRunFromGateway(dispatch);
}
