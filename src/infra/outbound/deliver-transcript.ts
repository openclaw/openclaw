// Mirrors successful outbound payloads into the configured session transcript.
import { resolveSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import {
  getOwnedSessionTranscriptWriterFence,
  runWithoutOwnedSessionTranscriptWrites,
  type SessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatErrorMessage } from "../errors.js";
import type { DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import type { DeliveryMirror } from "./mirror.js";
import { resolveOutboundPayloadMirrorText, type NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");
const loadTranscriptRuntime = createLazyRuntimeModule(
  () => import("../../config/sessions/transcript.runtime.js"),
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
    mediaUrls: params.payloads.flatMap((payload) => payload.mediaUrls),
  };
  const mirrorText = resolveMirroredTranscriptText({
    text: deliveredMirror.text,
    mediaUrls: deliveredMirror.mediaUrls,
  });
  if (!mirrorText) {
    return;
  }
  const append = {
    mirror,
    text: mirrorText,
    cfg: params.delivery.cfg,
    channel: params.channel,
    to: params.to,
  };
  if (mirror.deferToSessionLane) {
    // A non-owner append while another run prepares its context breaks that
    // run's transcript fences. The session lane orders it after that run.
    // The delivering request returns first; its Gateway root stays open until
    // the append settles so graceful shutdown waits for it.
    const releaseRootWork = retainGatewayRootWorkAdmissionContinuation();
    // Lane tasks inherit the enqueuer's async context; a sender's writer claim
    // is stale by the time this runs.
    enqueueCommandInLane(
      resolveSessionLane(mirror.sessionKey),
      () => runWithoutOwnedSessionTranscriptWrites(() => appendMirrorBestEffort(append)),
      { taskIdentity: { taskKind: "delivery-mirror", sessionKey: mirror.sessionKey } },
    )
      .catch((err: unknown) => warnMirrorFailed(append, formatErrorMessage(err)))
      .finally(() => releaseRootWork?.());
    return;
  }
  // Fence against the session this mirror lands in, not whichever run is delivering:
  // a cross-session delivery would otherwise carry the sending run's writer claim.
  const writerFence = getOwnedSessionTranscriptWriterFence({ sessionKey: mirror.sessionKey });
  await appendMirrorBestEffort({ ...append, writerFence });
}

type MirrorAppend = {
  mirror: DeliveryMirror;
  text: string;
  cfg: OpenClawConfig;
  channel: string;
  to: string;
  writerFence?: SessionTranscriptWriterFence;
};

// Transcript mirroring is best-effort bookkeeping after platform send.
// Keep mirror failures non-fatal so callers do not retry an already-sent payload.
async function appendMirrorBestEffort(params: MirrorAppend): Promise<void> {
  const { mirror, writerFence } = params;
  try {
    const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      agentId: mirror.agentId,
      sessionKey: mirror.sessionKey,
      expectedSessionId: mirror.expectedSessionId,
      ...(writerFence?.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
        : {}),
      ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
      text: params.text,
      idempotencyKey: mirror.idempotencyKey,
      deliveryMirror: mirror.deliveryMirror,
      config: params.cfg,
    });
    if (!mirrorResult.ok) {
      warnMirrorFailed(params, mirrorResult.reason);
    }
  } catch (err) {
    warnMirrorFailed(params, formatErrorMessage(err));
  }
}

function warnMirrorFailed(params: MirrorAppend, reason: string): void {
  log.warn(
    `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${reason}`,
    { channel: params.channel, to: params.to, sessionKey: params.mirror.sessionKey },
  );
}
