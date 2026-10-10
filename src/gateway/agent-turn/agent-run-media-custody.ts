import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { createOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { createAssistantCommentaryMediaCustody } from "../server-methods/chat-send-commentary-media.js";

/** Keep final payload media under the same Gateway run that owns its progress media. */
export function createAgentRunMediaCustody(
  params: Parameters<typeof createAssistantCommentaryMediaCustody>[0] & {
    options: AgentCommandGatewayIngressOpts;
    incognito: boolean;
  },
) {
  const { options } = params;
  const commentary = createAssistantCommentaryMediaCustody(params);
  const finalize: NonNullable<AgentCommandGatewayIngressOpts["beforeTerminalDelivery"]> = async (
    reply,
  ) => {
    if (
      !reply ||
      params.incognito ||
      options.privateCompletion ||
      options.sessionEffects === "internal" ||
      options.deliver === true ||
      options.internalDeliveryMediaUrls !== undefined ||
      !isInternalMessageChannel(options.channel ?? options.messageChannel)
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
    await finalizeAgentRunMedia(params, reply, plan);
  };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return commentary.run(operation);
    },
    prepareAssistantTranscriptMessage: commentary.prepareAssistantTranscriptMessage,
    finalize,
  };
}
