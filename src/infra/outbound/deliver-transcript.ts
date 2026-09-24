// Mirrors successful outbound payloads into the configured session transcript.
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import { getOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatErrorMessage } from "../errors.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { resolveOutboundMediaAccessForSend } from "./deliver-payload.js";
import { resolveOutboundPayloadMirrorText, type NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");
const loadTranscriptRuntime = createLazyRuntimeModule(
  () => import("../../config/sessions/transcript.runtime.js"),
);
const loadManagedMediaRuntime = createLazyRuntimeModule(
  () => import("../../gateway/managed-image-attachments.js"),
);

export async function mirrorDeliveredPayloads(params: {
  delivery: DeliverOutboundPayloadsCoreParams;
  payloads: readonly NormalizedOutboundPayload[];
  channel: string;
  to: string;
}): Promise<void> {
  const mirror = params.delivery.mirror;
  if (!mirror || params.payloads.length === 0) {
    return;
  }
  const deliveredMirror = {
    text: params.payloads
      .map((payload) => payload.hookContent ?? resolveOutboundPayloadMirrorText(payload))
      .filter((text) => text.trim())
      .join("\n"),
    mediaUrls: params.payloads.flatMap((payload) =>
      payload.sensitiveMedia ? [] : payload.mediaUrls,
    ),
  };
  const mirrorText = resolveMirroredTranscriptText({
    text: deliveredMirror.text,
    mediaUrls: deliveredMirror.mediaUrls,
  });
  if (!mirrorText) {
    return;
  }
  // Transcript mirroring is best-effort bookkeeping after platform send.
  // Keep mirror failures non-fatal so callers do not retry an already-sent payload.
  try {
    const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
    // Fence against the session this mirror lands in, not whichever run is delivering:
    // a cross-session delivery would otherwise carry the sending run's writer claim.
    const writerFence = getOwnedSessionTranscriptWriterFence({ sessionKey: mirror.sessionKey });
    const preparedBlocks: Record<string, unknown>[] = [];
    let committed = false;
    const mediaRuntime = deliveredMirror.mediaUrls.length
      ? await loadManagedMediaRuntime()
      : undefined;
    try {
      const mirrorResult = await appendAssistantMessageToSessionTranscript({
        agentId: mirror.agentId,
        sessionKey: mirror.sessionKey,
        expectedSessionId: mirror.expectedSessionId,
        ...(writerFence?.expectedLifecycleRevision !== undefined
          ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
          : {}),
        ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
        text: mirrorText,
        mediaUrls: deliveredMirror.mediaUrls,
        ...(mediaRuntime
          ? {
              content: [{ type: "text" as const, text: mirrorText }],
              prepareDisplayContent: async () => {
                for (const payload of params.payloads) {
                  if (payload.sensitiveMedia || !payload.mediaUrls.length) {
                    continue;
                  }
                  const mediaAccess = resolveOutboundMediaAccessForSend(
                    params.delivery,
                    params.channel,
                    payload.mediaUrls,
                  );
                  const blocks = await mediaRuntime.createManagedOutgoingMediaBlocks({
                    sessionKey: mirror.sessionKey,
                    agentId: mirror.agentId,
                    items: mediaRuntime.prepareOutgoingMediaFromReplyPayload(payload),
                    mediaAccess,
                    localRoots: mediaAccess.localRoots,
                    abortSignal: params.delivery.abortSignal,
                    continueOnPrepareError: true,
                  });
                  if (payload.audioAsVoice) {
                    for (const block of blocks) {
                      if (block.type === "audio") {
                        block.isVoiceNote = true;
                      }
                    }
                  }
                  preparedBlocks.push(...blocks);
                }
                return [{ type: "text", text: mirrorText }, ...preparedBlocks];
              },
              onMessageCommitted: async (result) => {
                // A later publication error must not delete media already owned by history.
                committed = result.appended;
                const blocks = readAssistantDisplayContent(result.message).filter(
                  (block) => block.type !== "text",
                );
                if (
                  blocks.length > 0 &&
                  !(await mediaRuntime.attachManagedOutgoingMediaToMessage({
                    messageId: result.messageId,
                    blocks,
                  }))
                ) {
                  throw new Error("Delivery mirror media ownership could not be persisted");
                }
              },
            }
          : {}),
        idempotencyKey: mirror.idempotencyKey,
        deliveryMirror: mirror.deliveryMirror,
        config: params.delivery.cfg,
      });
      if (!mirrorResult.ok) {
        log.warn(
          `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${mirrorResult.reason}`,
          { channel: params.channel, to: params.to, sessionKey: mirror.sessionKey },
        );
      }
    } finally {
      if (!committed && preparedBlocks.length && mediaRuntime) {
        await mediaRuntime.removeManagedOutgoingMediaBlocks({
          blocks: preparedBlocks,
          messageId: null,
        });
      }
    }
  } catch (err) {
    log.warn(
      `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${formatErrorMessage(err)}`,
      { channel: params.channel, to: params.to, sessionKey: mirror.sessionKey },
    );
  }
}
