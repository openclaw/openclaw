import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { scopeCommandTranscriptId } from "../../config/sessions/command-transcript.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../reply-payload.js";
import { resolveCommandContextText } from "./context-text.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import {
  captureDeliveredTranscriptMirror,
  mirrorDeliveredReplyToTranscript,
  transcriptMirrorForDeliveredPayload,
} from "./dispatch-from-config.transcript.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatch-outcome.js";

/**
 * Builds delivered-reply transcript mirrors for one dispatch. Only replies marked
 * by a command owner form a command exchange: an agent turn that merely starts
 * with an inline "/" directive already records its own user row.
 */
export function createDispatchTranscriptMirrors(state: PrepareDispatchOperationReadyState) {
  const { cfg, ctx, dispatcher, sessionStoreEntry } = state;
  const commandText = ctx.CommandInterpretationSuppressed
    ? undefined
    : normalizeOptionalString(resolveCommandContextText(ctx));
  const targetKey = state.acpDispatchSessionKey ?? sessionStoreEntry.sessionKey ?? state.sessionKey;
  const expectedWriterRunId = normalizeOptionalString(state.params.replyOptions?.runId);
  const isCommandReply = (payload: ReplyPayload) =>
    getReplyPayloadMetadata(payload)?.commandReply === true &&
    Boolean(commandText?.startsWith("/"));
  const writer = (sessionKey: string | undefined) => {
    const binding = state.resolvePreparedTranscriptBinding(sessionKey);
    const expectedLifecycleRevision = sessionStoreEntry.entry?.lifecycleRevision;
    return {
      ...(binding ? { expectedSessionId: binding.sessionId } : {}),
      ...(expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision } : {}),
      ...(expectedWriterRunId ? { expectedWriterRunId } : {}),
      storePath: binding?.storePath ?? sessionStoreEntry.storePath,
    };
  };
  let blockIndex = 0;
  const block = (payload: ReplyPayload) => {
    const commandId = scopeCommandTranscriptId(
      normalizeOptionalString(state.messageIdForHook),
      state.hookState.inboundClaimContext,
    );
    if (!commandText || !commandId || !targetKey || !isCommandReply(payload)) {
      return undefined;
    }
    const binding = state.resolvePreparedTranscriptBinding(targetKey);
    return transcriptMirrorForDeliveredPayload(
      {
        sessionKey: targetKey,
        agentId: state.sessionAgentId,
        expectedSessionId: binding?.sessionId,
        storePath: binding?.storePath ?? sessionStoreEntry.storePath,
        commandText,
        commandId,
        preferText: true,
        idempotencyKey: `command-block:${commandId}:${++blockIndex}`,
        deliveryMirror: { kind: "channel-final", sourceMessageId: commandId },
      },
      payload,
    );
  };
  return {
    isCommandReply,
    sourceReply(mirror: ReplyPayloadMetadata["sourceReplyTranscriptMirror"]) {
      return mirror ? { ...mirror, ...writer(mirror.sessionKey) } : undefined;
    },
    /** Captures a queued block before send; the result records it once delivered. */
    captureBlock(payload: ReplyPayload) {
      const mirror = block(payload);
      const captureToken = mirror ? {} : undefined;
      const deliveredMirror = captureDeliveredTranscriptMirror({
        dispatcher,
        metadata: mirror,
        captureToken,
        kind: "block",
      });
      if (captureToken) {
        setReplyPayloadMetadata(payload, { finalDeliveryCapture: captureToken });
      }
      return (delivery: { queued: boolean; outcome?: Promise<ReplyDispatchDeliveryOutcome> }) => {
        if (mirror && delivery.queued && delivery.outcome) {
          registerReplyDispatcherSettledTask(dispatcher, async () => {
            if ((await delivery.outcome) === "delivered") {
              await mirrorDeliveredReplyToTranscript({ metadata: deliveredMirror(), cfg });
            }
          });
        }
      };
    },
    recordRoutedBlock(payload: ReplyPayload) {
      const metadata = block(payload);
      if (metadata) {
        registerReplyDispatcherSettledTask(dispatcher, () =>
          mirrorDeliveredReplyToTranscript({ metadata, cfg }),
        );
      }
    },
    final(
      payload: ReplyPayload,
      params: {
        command: boolean;
        sourceId?: string;
        transcriptOwner: boolean;
        deliveryId?: string;
      },
    ) {
      if ((state.normalizedCurrentSurface !== "slack" && !params.command) || !targetKey) {
        return undefined;
      }
      const { sourceId } = params;
      const commandId = params.command
        ? scopeCommandTranscriptId(sourceId, state.hookState.inboundClaimContext)
        : undefined;
      return transcriptMirrorForDeliveredPayload(
        {
          sessionKey: targetKey,
          agentId: state.sessionAgentId,
          ...writer(targetKey),
          preferText: true,
          ...(commandText && commandId ? { commandText, commandId } : {}),
          ...(params.transcriptOwner ? { transcriptOwner: true } : {}),
          idempotencyKey: sourceId
            ? `channel-final:${commandId ?? sourceId}:${params.deliveryId ?? "single"}`
            : undefined,
          deliveryMirror: {
            kind: "channel-final",
            ...(sourceId ? { sourceMessageId: sourceId } : {}),
          },
        },
        payload,
      );
    },
  };
}
