import { createDefaultDeps } from "../cli/deps.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/config.js";
import { withTranscriptWriteSequence } from "../config/sessions/session-accessor.js";
import { projectAssistantTranscriptText } from "../config/sessions/transcript-assistant-delivery-read.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import {
  isUpdateRunTerminalNoticeText,
  renderUpdateRunNotice,
  type UpdateRunNoticeKind,
} from "../infra/update-run-notice.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import {
  recordUpdateRunStepAsync as recordUpdateRunStep,
  recordUpdateRunVerificationAsync as recordUpdateRunVerification,
} from "../infra/update-run-write.async.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sendGatewayLifecycleNotice } from "./server-restart-sentinel-notice.js";
import {
  authorizeUpdateRunNoticeTarget,
  recordUpdateRunNoticeSkipped,
  resolveUpdateRunNoticeTarget,
} from "./update-run-notice-target.js";

const log = createSubsystemLogger("gateway/update-run");

/** Replay the admitted completion bytes, including after an interrupted run changes outcome. */
export async function appendUpdateRunFinishedNotice(
  params: Parameters<typeof appendAssistantMessageToSessionTranscript>[0] & {
    expectedSessionId: string;
    idempotencyKey: string;
  },
) {
  const previous = await withTranscriptWriteSequence(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.expectedSessionId,
      storePath: params.storePath,
    },
    async (transcript) => {
      const facts = await transcript.readMessageFacts({ idempotencyKeys: [params.idempotencyKey] });
      return projectAssistantTranscriptText(
        facts.messagesByIdempotencyKey.get(params.idempotencyKey),
      );
    },
  );
  // Re-enter the normal append owner so a replaced session still rejects the write.
  return appendAssistantMessageToSessionTranscript({
    ...params,
    text: previous && isUpdateRunTerminalNoticeText(previous.text) ? previous.text : params.text,
  });
}

/** Prepare routing before an update can replace lazily loaded channel modules. */
export async function createUpdateRunNotifier(
  initial: UpdateRunRecord,
  getConfig: () => OpenClawConfig = getRuntimeConfig,
  deps: CliDeps = createDefaultDeps(),
  target?: Awaited<ReturnType<typeof resolveUpdateRunNoticeTarget>>,
  context: DeliveryQueueStateContext = captureDeliveryQueueStateContext(),
) {
  const env = context.workerContext.environment;
  const noticeTarget =
    target ??
    (await resolveUpdateRunNoticeTarget({
      cfg: getConfig(),
      sessionKey: initial.origin.sessionKey,
      explicitDeliveryContext: initial.origin.deliveryContext,
      threadId: initial.origin.deliveryContext?.threadId,
      env,
    }));
  const { sessionKey } = initial.origin;
  // Update delivery belongs to the host and can outlive the requesting attempt.
  return (run: UpdateRunRecord, kind: UpdateRunNoticeKind) =>
    runWithoutOwnedSessionTranscriptWrites(async () => {
      // Pre-park and later activation share one durable notice, never a fifth milestone.
      const milestone = kind === "parking" ? "activating" : kind;
      const noticeStep =
        kind === "finished"
          ? undefined
          : run.steps.find((step) => step.step === `notice:${milestone}`);
      const recorded =
        kind === "finished"
          ? run.verification.noticeDelivered === true
          : noticeStep?.status === "completed";
      if (recorded || noticeStep?.status === "skipped") {
        return { delivered: false, owned: recorded };
      }
      const message = renderUpdateRunNotice(run, kind);
      if (!message) {
        return { delivered: false, owned: false };
      }
      const cfg = getConfig();
      const currentTarget = authorizeUpdateRunNoticeTarget(cfg, noticeTarget);
      const recordNoticeStep = (status: "completed" | "skipped", detail?: string) =>
        recordUpdateRunStep(
          run.runId,
          {
            step: `notice:${milestone}`,
            status,
            endedAtMs: Date.now(),
            ...(detail ? { detail } : {}),
          },
          { env },
        );
      if (currentTarget.kind === "none") {
        await recordUpdateRunNoticeSkipped(run.runId, currentTarget.reason, env);
        if (kind !== "finished") {
          await recordNoticeStep("skipped", currentTarget.reason);
        }
        return { delivered: false, owned: false };
      }
      // Admission, the watcher, and successor startup share permanent delivery
      // ownership. A repeated phase or sentinel revision cannot send a fifth message.
      const deliveryIntentId = `update-run-${milestone}:${run.runId}`;
      let delivered: boolean;
      if (currentTarget.kind === "route") {
        delivered = await sendGatewayLifecycleNotice(
          {
            ...currentTarget.route,
            cfg,
            deps,
            sessionKey,
            message,
            deliveryIntentId,
          },
          context,
        );
      } else {
        const internal = currentTarget.session;
        const append =
          kind === "finished"
            ? appendUpdateRunFinishedNotice
            : appendAssistantMessageToSessionTranscript;
        const notice = await append({
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
        await recordUpdateRunVerification(run.runId, { noticeDelivered: true }, { env });
      }
      const custody =
        currentTarget.kind === "route"
          ? await findDeliveryIntentOwner(deliveryIntentId, undefined, context)
          : null;
      const owned = delivered || custody?.status === "pending" || custody?.status === "completed";
      if (owned && kind !== "finished") {
        await recordNoticeStep("completed");
      }
      return { delivered, owned };
    });
}

export async function notifyUpdateRunPhase(run: UpdateRunRecord): Promise<void> {
  if (run.phase === "activating" || run.phase === "finished") {
    const notify = await createUpdateRunNotifier(run);
    await notify(run, run.phase);
  }
}
