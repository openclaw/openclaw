import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { renderUserFacingText } from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { logVerbose } from "../../globals.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import type { PartialReplyPayload } from "../get-reply-options.types.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { BlockReplyContext, GetReplyOptions, ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createBlockReplyDeliveryHandler, type DirectBlockDelivery } from "./reply-delivery.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import { hasCommittedReplyOperationOutcome } from "./reply-run-registry.js";

export async function deliverPreparedBlockReply(
  opts: Pick<GetReplyOptions, "onPreparedBlockReply" | "onBlockReply"> | undefined,
  payload: ReplyPayload,
  context?: BlockReplyContext,
): Promise<void> {
  if (opts?.onPreparedBlockReply) {
    for (const plan of createStructuredOutboundPayloadPlan([payload])) {
      await opts.onPreparedBlockReply(plan, context);
    }
  } else {
    await opts?.onBlockReply?.(payload, context);
  }
}

/** Builds the channel-presentation callbacks shared by CLI and embedded runs. */
export function createAgentTurnPresentation(params: {
  turn: AgentTurnParams;
  replyMediaContext: ReplyMediaContext;
  directBlockDeliveries: DirectBlockDelivery[];
  heartbeatState: { didLogStrip: boolean };
}) {
  const classifyReplyText = (
    payload: ReplyPayload,
    hasHeartbeatToken?: boolean,
  ): { text?: string; skip: boolean } => {
    let text = payload.text;
    const reply = resolveSendableOutboundReplyParts(payload, { text: "" });
    if (params.turn.followupRun.run.silentExpected) {
      return { skip: true };
    }
    if (!params.turn.isHeartbeat && hasHeartbeatToken !== false && text?.includes("HEARTBEAT_OK")) {
      const stripped = stripHeartbeatToken(text, { mode: "message" });
      if (stripped.didStrip && !params.heartbeatState.didLogStrip) {
        params.heartbeatState.didLogStrip = true;
        logVerbose("Stripped stray HEARTBEAT_OK token from reply");
      }
      if (stripped.shouldSkip && !reply.hasMedia) {
        return { skip: true };
      }
      text = stripped.text;
    }
    if (getReplyPayloadMetadata(payload)?.silentReply === true) {
      return { skip: true };
    }
    if (!text) {
      return reply.hasMedia ? { text: undefined, skip: false } : { skip: true };
    }
    return { text, skip: false };
  };

  const sanitizeStreamingText = (
    text: string | undefined,
    errorContext: boolean,
  ): { text?: string; skip: boolean } => {
    if (!text) {
      return { skip: true };
    }
    const conversationContext =
      params.turn.sessionCtx.agentText ?? params.turn.sessionCtx.BodyForAgent;
    const sanitized = errorContext
      ? renderUserFacingText(text, { errorContext: true, conversationContext, streaming: true })
      : sanitizeUserFacingText(text, { conversationContext, streaming: true });
    return sanitized.trim() ? { text: sanitized, skip: false } : { skip: true };
  };

  const normalizeStreamingText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
    const classified = classifyReplyText(payload);
    if (classified.skip || !classified.text) {
      return classified;
    }
    return sanitizeStreamingText(classified.text, Boolean(payload.isError));
  };

  const preserveProgressCallbackStartOrder =
    params.turn.opts?.preserveProgressCallbackStartOrder === true;
  const presentWithTyping = async (
    typingPromise: Promise<void>,
    startPresentation: () => boolean | void | Promise<boolean | void>,
  ) => {
    if (!preserveProgressCallbackStartOrder) {
      await typingPromise;
      const operation = params.turn.replyOperation;
      // Successful settlement keeps delivery alive; delayed typing must not
      // reopen presentation after this operation has committed its final answer.
      if (
        operation &&
        (operation.abortSignal.aborted ||
          operation.result ||
          hasCommittedReplyOperationOutcome(operation))
      ) {
        return false;
      }
      return await startPresentation();
    }
    let presentationPromise: boolean | void | Promise<boolean | void>;
    try {
      presentationPromise = startPresentation();
    } catch (err) {
      // Typing already started; observe a secondary failure if presentation throws inline.
      void typingPromise.catch(() => undefined);
      throw err;
    }
    const [, result] = await Promise.all([typingPromise, presentationPromise]);
    return result;
  };

  let partialHeartbeatTail = "";
  let hasPartialHeartbeatToken = false;
  let partialTypingLength = 0;
  let partialTypingCharacter: string | undefined;
  const presentPartialReply = async (
    payload: ReplyPayload & Pick<PartialReplyPayload, "delta" | "replace">,
    runtime: "cli" | "embedded",
  ) => {
    const delta = payload.delta;
    const incremental = runtime === "embedded" && delta !== undefined && !payload.replace;
    if (!hasPartialHeartbeatToken && !params.turn.isHeartbeat) {
      const probe = incremental ? partialHeartbeatTail + delta : (payload.text ?? "");
      hasPartialHeartbeatToken = probe.includes("HEARTBEAT_OK");
      // Retain overlap for split tokens; a new message can only cause a conservative match.
      partialHeartbeatTail = probe.slice(-"HEARTBEAT_OK".length + 1);
    }
    const classified = classifyReplyText(payload, hasPartialHeartbeatToken);
    if (classified.skip || !classified.text) {
      return runtime === "embedded" ? false : undefined;
    }
    let textForTyping = classified.text;
    if (incremental && !hasPartialHeartbeatToken) {
      const appended = classified.text.length === partialTypingLength + delta.length;
      const character = /\S/.exec(appended ? delta : classified.text)?.[0];
      partialTypingCharacter = character ?? (appended ? partialTypingCharacter : undefined);
      partialTypingLength = classified.text.length;
      // Typing needs presence, including whitespace appended after visible text, not a snapshot.
      textForTyping = partialTypingCharacter ?? "";
    } else {
      partialTypingLength = 0;
    }
    let didMaterialize = false;
    let materializedText: string | undefined;
    const materializeText = () => {
      if (!didMaterialize) {
        const sanitized = sanitizeStreamingText(classified.text, false);
        materializedText = sanitized.skip ? undefined : sanitized.text;
        didMaterialize = true;
      }
      return materializedText;
    };
    // Embedded drafts consume cumulative text lazily; CLI previews arrive already paced.
    const partialPayload: PartialReplyPayload =
      runtime === "cli"
        ? { text: materializeText() }
        : {
            get text() {
              return materializeText();
            },
            mediaUrls: payload.mediaUrls,
          };
    const onPartialReply = params.turn.opts?.onPartialReply;
    return await presentWithTyping(params.turn.typingSignals.signalTextDelta(textForTyping), () =>
      !onPartialReply || (runtime === "cli" && !partialPayload.text)
        ? false
        : onPartialReply(partialPayload),
    );
  };

  const blockReplyPipeline = params.turn.blockReplyPipeline;
  // One handler owns threading and direct-send dedupe for this fallback cycle.
  const blockReplyHandler =
    params.turn.opts?.onPreparedBlockReply || params.turn.opts?.onBlockReply
      ? createBlockReplyDeliveryHandler({
          onBlockReply: (payload, context) =>
            deliverPreparedBlockReply(params.turn.opts, payload, context),
          currentMessageId:
            params.turn.sessionCtx.MessageSidFull ?? params.turn.sessionCtx.MessageSid,
          replyThreading: params.turn.replyThreading,
          normalizeStreamingText,
          applyReplyToMode: params.turn.applyReplyToMode,
          normalizeMediaPaths: params.replyMediaContext.normalizePayload,
          typingSignals: params.turn.typingSignals,
          reasoningPayloadsEnabled: params.turn.opts?.reasoningPayloadsEnabled,
          commentaryPayloadsEnabled: params.turn.opts?.commentaryPayloadsEnabled,
          blockStreamingEnabled: params.turn.blockStreamingEnabled,
          blockReplyPipeline,
          directBlockDeliveries: params.directBlockDeliveries,
        })
      : undefined;

  return {
    presentPartialReply,
    normalizeStreamingText,
    presentWithTyping,
    blockReplyHandler,
  };
}
