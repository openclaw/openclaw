import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { WebchatReplyMediaRequesterContext } from "../server-methods/chat-reply-media.js";
import { resolveChatSendCallerContext } from "../server-methods/gateway-client-identity.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/** Prepare input and assistant media while dispatch retains the run's authority. */
export function dispatchAgentRunWithMedia(
  dispatch: Parameters<typeof dispatchAgentRunFromGateway>[0],
  params: Pick<
    StartAgentRunExecutionParams,
    "cfg" | "client" | "activeSessionAgentId" | "sessionEntry"
  > & {
    prepared: Pick<
      StartAgentRunExecutionParams["prepared"],
      "lifecycleStorePath" | "imageUnderstandingModel" | "replyDispatchRuntime"
    >;
  },
) {
  const { ingressOpts, admittedRunEntry, abortController } = dispatch;
  const sessionKey = ingressOpts.sessionKey;
  if (!sessionKey && !params.prepared.imageUnderstandingModel) {
    return dispatchAgentRunFromGateway(dispatch);
  }
  const caller: WebchatReplyMediaRequesterContext | undefined = params.client
    ? resolveChatSendCallerContext(params.client)
    : undefined;
  const runContext = ingressOpts.runContext;
  // Preserve the dispatch object's execution-identity binding.
  dispatch.loadMedia = async () => {
    const cfg = dispatch.commandRuntimeContext?.config ?? params.cfg;
    if (params.prepared.imageUnderstandingModel) {
      const { prepareAgentImageUnderstanding } = await import("./agent-image-understanding.js");
      const runtime = params.prepared.replyDispatchRuntime;
      dispatch.assertCurrent?.();
      const input = await prepareAgentImageUnderstanding({
        message: ingressOpts.message,
        media: ingressOpts.media ?? [],
        cfg,
        agentId: params.activeSessionAgentId,
        agentDir: runtime.agentDir,
        workspaceDir: ingressOpts.workspaceDir ?? runtime.workspaceDir,
        sessionKey,
        channel: runContext?.messageChannel ?? ingressOpts.messageChannel,
        chatType: params.sessionEntry?.chatType,
        activeModel: params.prepared.imageUnderstandingModel,
        execution: {
          signal: abortController.signal,
          assertCurrent: () => dispatch.assertCurrent?.(),
        },
      });
      dispatch.assertCurrent?.();
      Object.assign(ingressOpts, input, { imageOrder: [] });
    }
    if (!sessionKey) {
      return undefined;
    }
    const { createAssistantCommentaryMediaCustody } =
      await import("../server-methods/chat-send-commentary-media.js");
    const { createOutboundPayloadPlan } = await import("../../infra/outbound/payloads.js");
    const mediaParams = {
      options: ingressOpts,
      incognito: dispatch.isIncognito === true,
      session: {
        agentId: params.activeSessionAgentId,
        cfg,
        storePath: params.prepared.lifecycleStorePath,
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
    };
    const commentary = createAssistantCommentaryMediaCustody(mediaParams);
    return {
      run: commentary.run,
      prepareAssistantTranscriptMessage: commentary.prepareAssistantTranscriptMessage,
      finalize: async (reply) => {
        if (
          !reply ||
          mediaParams.incognito ||
          ingressOpts.privateCompletion ||
          ingressOpts.sessionEffects === "internal" ||
          ingressOpts.deliver === true ||
          !isInternalMessageChannel(ingressOpts.channel ?? ingressOpts.messageChannel)
        ) {
          return;
        }
        const plan = createOutboundPayloadPlan(reply.payloads).filter(
          ({ payload }) => payload.sensitiveMedia !== true,
        );
        if (!plan.some(({ parts }) => parts.mediaUrls.length > 0)) {
          return;
        }
        const { finalizeAgentRunMedia } = await import("./agent-run-final-media.js");
        await finalizeAgentRunMedia(mediaParams, reply, plan);
      },
    };
  };
  return dispatchAgentRunFromGateway(dispatch);
}
