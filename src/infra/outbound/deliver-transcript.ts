// Mirrors successful outbound payloads into the configured session transcript.
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  getOwnedSessionTranscriptWriterFence,
  runWithoutOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatErrorMessage } from "../errors.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import type { OutboundMirror } from "./mirror.js";
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
  const mirrorContent = {
    text: params.payloads
      .map((payload) => payload.hookContent ?? resolveOutboundPayloadMirrorText(payload))
      .filter((text) => text.trim())
      .join("\n"),
    mediaUrls: params.payloads.flatMap((payload) => payload.mediaUrls),
  };
  if (!mirrorContent.text && mirrorContent.mediaUrls.length === 0) {
    return;
  }
  await appendOutboundMirror({
    cfg: params.delivery.cfg,
    mirror: { ...mirror, ...mirrorContent },
    logContext: { channel: params.delivery.channel, to: params.delivery.to },
  });
}

/** Appends an accepted send's transcript copy; deferred copies run in the destination lane. */
export async function appendOutboundMirror(params: {
  cfg: OpenClawConfig;
  mirror: OutboundMirror;
  logContext?: Record<string, unknown>;
}): Promise<void> {
  const { mirror } = params;
  const warnFailure = (reason: string) =>
    log.warn(
      `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${reason}`,
      { ...params.logContext, sessionKey: mirror.sessionKey },
    );
  // Transcript mirroring is best-effort bookkeeping after platform send.
  // Keep mirror failures non-fatal so callers do not retry an already-sent payload.
  const append = async () => {
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
        text: mirror.text,
        mediaUrls: mirror.mediaUrls,
        idempotencyKey: mirror.idempotencyKey,
        deliveryMirror: mirror.deliveryMirror,
        config: params.cfg,
      });
      if (!mirrorResult.ok) {
        warnFailure(mirrorResult.reason);
      }
    } catch (err) {
      warnFailure(formatErrorMessage(err));
    }
  };
  if (mirror.deferToSessionLane) {
    // Do not await the requester lane: its turn can be waiting for this delivery.
    // Keep shutdown custody, but discard the sender's work scope and writer claim.
    const releaseRootWork = retainGatewayRootWorkAdmissionContinuation();
    void runOutsideAsyncWorkScope(() =>
      enqueueCommandInLane(
        resolveSessionLane(mirror.sessionKey),
        () => runWithoutOwnedSessionTranscriptWrites(append),
        { taskIdentity: { taskKind: "delivery-mirror", sessionKey: mirror.sessionKey } },
      ),
    )
      .catch((error: unknown) => warnFailure(formatErrorMessage(error)))
      .finally(() => releaseRootWork?.());
    return;
  }
  await append();
}
