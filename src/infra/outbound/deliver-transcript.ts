// Mirrors successful outbound payloads into the configured session transcript.
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import { getOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatErrorMessage } from "../errors.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { resolveOutboundPayloadMirrorText, type NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");
const loadTranscriptRuntime = createLazyRuntimeModule(
  () => import("../../config/sessions/transcript.runtime.js"),
);

export async function mirrorDeliveredPayloads(params: {
  delivery: DeliverOutboundPayloadsCoreParams;
  payloads: readonly NormalizedOutboundPayload[];
}): Promise<void> {
  const mirror = params.delivery.mirror;
  if (!mirror || params.payloads.length === 0) {
    return;
  }
  const mirrorText = resolveMirroredTranscriptText({
    text: params.payloads
      .map((payload) => payload.hookContent ?? resolveOutboundPayloadMirrorText(payload))
      .filter((text) => text.trim())
      .join("\n"),
    mediaUrls: params.payloads.flatMap((payload) => payload.mediaUrls),
  });
  if (!mirrorText) {
    return;
  }
  const warnFailure = (reason: string) =>
    log.warn(
      `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${reason}`,
      { channel: params.delivery.channel, to: params.delivery.to, sessionKey: mirror.sessionKey },
    );
  // Transcript mirroring is best-effort bookkeeping after platform send.
  // Keep mirror failures non-fatal so callers do not retry an already-sent payload.
  try {
    const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
    // Fence against the session this mirror lands in, not whichever run is delivering:
    // a cross-session delivery would otherwise carry the sending run's writer claim.
    const writerFence = getOwnedSessionTranscriptWriterFence({ sessionKey: mirror.sessionKey });
    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      agentId: mirror.agentId,
      sessionKey: mirror.sessionKey,
      expectedSessionId: mirror.expectedSessionId,
      ...(writerFence?.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
        : {}),
      ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
      text: mirrorText,
      idempotencyKey: mirror.idempotencyKey,
      deliveryMirror: mirror.deliveryMirror,
      config: params.delivery.cfg,
    });
    if (!mirrorResult.ok) {
      warnFailure(mirrorResult.reason);
    }
  } catch (err) {
    warnFailure(formatErrorMessage(err));
  }
}
