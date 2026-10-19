// Mirrors successful outbound payloads into the configured session transcript.
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  getOwnedSessionTranscriptWriterFence,
  runWithoutOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.owner-context.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
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
  const warnFailure = (reason: string) =>
    log.warn(
      `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${reason}`,
      { channel: params.delivery.channel, to: params.delivery.to, sessionKey: mirror.sessionKey },
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
        ...mirrorContent,
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
  };
  if (mirror.deferToSessionLane) {
    // Do not await the requester: its turn can be waiting for this delivery.
    // Retain shutdown custody while acquiring independent controller mutation ownership.
    const releaseRootWork = retainGatewayRootWorkAdmissionContinuation();
    void runWithSessionControllerCleanup(() =>
      runOutsideAsyncWorkScope(async () => {
        const agentId = resolveSessionAgentId({
          config: params.delivery.cfg,
          sessionKey: mirror.sessionKey,
          agentId: mirror.agentId,
        });
        await runSessionMutation({
          scope: resolveSessionStorePathCore(params.delivery.cfg.session?.store, { agentId }),
          identities: [mirror.sessionKey, mirror.expectedSessionId],
          agentId,
          policy: "wait",
          run: () => runWithoutOwnedSessionTranscriptWrites(append),
        });
      }),
    )
      .catch((error: unknown) => warnFailure(formatErrorMessage(error)))
      .finally(() => releaseRootWork?.());
    return;
  }
  await append();
}
