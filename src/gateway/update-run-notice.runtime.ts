import { createDefaultDeps } from "../cli/deps.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/config.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import { recordUpdateRunStep, recordUpdateRunVerification } from "../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { renderUpdateRunNotice, type UpdateRunNoticeKind } from "../infra/update-run-report.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sendGatewayLifecycleNotice } from "./server-restart-sentinel-notice.js";
import {
  authorizeUpdateRunNoticeTarget,
  recordUpdateRunNoticeSkipped,
  resolveUpdateRunNoticeTarget,
} from "./update-run-notice-target.js";

const log = createSubsystemLogger("gateway/update-run");

/** Prepare routing before an update can replace lazily loaded channel modules. */
export function createUpdateRunNotifier(
  initial: UpdateRunRecord,
  getConfig: () => OpenClawConfig = getRuntimeConfig,
  deps: CliDeps = createDefaultDeps(),
  target = resolveUpdateRunNoticeTarget({
    cfg: getConfig(),
    sessionKey: initial.origin.sessionKey,
    explicitDeliveryContext: initial.origin.deliveryContext,
    threadId: initial.origin.deliveryContext?.threadId,
  }),
) {
  const { sessionKey } = initial.origin;
  // Update delivery belongs to the host and can outlive the requesting attempt.
  return (run: UpdateRunRecord, kind: UpdateRunNoticeKind) =>
    runWithoutOwnedSessionTranscriptWrites(async () => {
      const message = renderUpdateRunNotice(run, kind);
      // Pre-park and later activation share one durable notice, never a fifth milestone.
      const milestone = kind === "parking" ? "activating" : kind;
      const recorded =
        kind === "finished"
          ? run.verification.noticeDelivered === true
          : run.steps.some(
              (step) => step.step === `notice:${milestone}` && step.status === "completed",
            );
      if (!message || recorded) {
        return { delivered: false, owned: recorded };
      }
      const cfg = getConfig();
      const currentTarget = authorizeUpdateRunNoticeTarget(cfg, target);
      if (currentTarget.kind === "none") {
        recordUpdateRunNoticeSkipped(run.runId, currentTarget.reason);
        return { delivered: false, owned: false };
      }
      // Admission, the watcher, and successor startup share permanent delivery
      // ownership. A repeated phase or sentinel revision cannot send a fifth message.
      const deliveryIntentId = `update-run-${milestone}:${run.runId}`;
      let delivered: boolean;
      if (currentTarget.kind === "route") {
        delivered = await sendGatewayLifecycleNotice({
          ...currentTarget.route,
          cfg,
          deps,
          sessionKey,
          message,
          deliveryIntentId,
        });
      } else {
        const internal = currentTarget.session;
        const notice = await appendAssistantMessageToSessionTranscript({
          agentId: internal.agentId,
          sessionKey: internal.canonicalKey,
          expectedSessionId: internal.entry.sessionId,
          expectedLifecycleRevision: internal.entry.lifecycleRevision ?? null,
          storePath: internal.storePath,
          text: message,
          idempotencyKey: deliveryIntentId,
        }).catch((error: unknown) => ({ ok: false as const, reason: formatErrorMessage(error) }));
        delivered = notice.ok;
        if (!notice.ok) {
          log.warn(`update run notice append failed: ${notice.reason}`);
        }
      }
      if (delivered && kind === "finished") {
        recordUpdateRunVerification(run.runId, { noticeDelivered: true });
      }
      const custody =
        currentTarget.kind === "route" ? findDeliveryIntentOwner(deliveryIntentId) : null;
      const owned = delivered || custody?.status === "pending" || custody?.status === "completed";
      if (owned && kind !== "finished") {
        recordUpdateRunStep(run.runId, {
          step: `notice:${milestone}`,
          status: "completed",
          endedAtMs: Date.now(),
        });
      }
      return { delivered, owned };
    });
}

export async function notifyUpdateRunPhase(run: UpdateRunRecord): Promise<void> {
  if (run.phase === "activating" || run.phase === "finished") {
    await createUpdateRunNotifier(run)(run, run.phase);
  }
}
