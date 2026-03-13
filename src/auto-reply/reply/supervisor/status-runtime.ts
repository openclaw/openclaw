import { logVerbose } from "../../../globals.js";
import type { ReplyPayload } from "../../types.js";
import type { QueueMode } from "../queue.js";
import {
  buildSupervisorDecisionRecord,
  appendSupervisorDecisionRecord,
} from "./decision-record.js";
import {
  appendSupervisorDecisionOutcomeRecord,
  buildSupervisorDecisionOutcomeRecord,
} from "./outcome-record.js";
import {
  buildSupervisorPresentationPlannedOutcomePayload,
  buildSupervisorPresentationSummary,
  buildSupervisorStatusOutcomePayload,
  buildSupervisorStatusPayload,
  planSupervisorPresentation,
} from "./presentation.js";
import { translateLegacyQueueDecision } from "./translate.js";
import type { TruthfulEarlyStatusActivation } from "./truthful-status-policy.js";

type ActiveRunStatusQueueMode = "interrupt" | "steer" | "steer-backlog" | "followup" | "collect";

export async function emitSupervisorStatusForActiveRun(params: {
  sessionFile: string;
  sessionKey: string;
  sessionId: string;
  queueMode: ActiveRunStatusQueueMode;
  source: string;
  bodyText: string;
  isStreaming: boolean;
  laneSize: number;
  sendStatus: (payload: ReplyPayload) => Promise<boolean | void> | boolean | void;
  earlyStatusActivation?: TruthfulEarlyStatusActivation;
}): Promise<void> {
  const translated = translateLegacyQueueDecision(params.queueMode as QueueMode);
  const plan = planSupervisorPresentation({
    event: {
      type: "user_message",
      category: "user",
      source: params.source,
      timestamp: Date.now(),
      payload: { text: params.bodyText },
      urgency: "normal",
      scope: "foreground",
    },
    taskState: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      phase: params.isStreaming ? "acting" : "planning",
      interruptPreference: params.queueMode === "interrupt" ? "critical" : "avoid",
      interruptibility: "interruptible",
      isActive: true,
      isStreaming: params.isStreaming,
      laneSize: params.laneSize,
    },
    relation: translated.relation,
    action: translated.action,
    runtimeDisposition:
      params.queueMode === "interrupt" ? "preempting_active_run" : "non_preemptive",
  });
  const statusPayload = buildSupervisorStatusPayload(plan);
  const summary = buildSupervisorPresentationSummary({
    plan,
    statusScheduledForRuntime: Boolean(statusPayload),
  });
  const earlyStatusPolicy = params.earlyStatusActivation
    ? {
        activationReason: params.earlyStatusActivation.reason,
        recommendationLevel: params.earlyStatusActivation.recommendation.level,
        recommendationReason: params.earlyStatusActivation.recommendation.reason,
      }
    : undefined;
  const decisionRecord = buildSupervisorDecisionRecord({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    event: {
      type: "user_message",
      category: "user",
      source: params.source,
      timestamp: Date.now(),
      payload: { text: params.bodyText },
      urgency: "normal",
      scope: "foreground",
    },
    taskStateSnapshot: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      phase: params.isStreaming ? "acting" : "planning",
      interruptPreference: params.queueMode === "interrupt" ? "critical" : "avoid",
      interruptibility: "interruptible",
      isActive: true,
      isStreaming: params.isStreaming,
      laneSize: params.laneSize,
    },
    relation: translated.relation,
    action: translated.action,
    classifier: { kind: translated.classifierKind },
    rationale: { short: translated.rationale, translation: translated.rationale },
    outcome: { status: "confirmed" },
    metadata: {
      finalQueueMode: params.queueMode,
      presentationPlan: plan,
      presentationSummary: summary,
    },
  });

  const appendRecordBestEffort = async () => {
    try {
      await appendSupervisorDecisionRecord({
        sessionFile: params.sessionFile,
        record: decisionRecord,
      });
      await appendSupervisorDecisionOutcomeRecord({
        sessionFile: params.sessionFile,
        record: buildSupervisorDecisionOutcomeRecord({
          decisionId: decisionRecord.id,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          signal: "runtime_applied",
          payload: {
            action: translated.action,
            relation: translated.relation,
            finalQueueMode: params.queueMode,
          },
        }),
      });
      await appendSupervisorDecisionOutcomeRecord({
        sessionFile: params.sessionFile,
        record: buildSupervisorDecisionOutcomeRecord({
          decisionId: decisionRecord.id,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          signal: "presentation_planned",
          payload: {
            ...buildSupervisorPresentationPlannedOutcomePayload(summary),
            ...(earlyStatusPolicy ? { earlyStatusPolicy } : {}),
          },
        }),
      });
    } catch (error) {
      logVerbose(
        `supervisor: failed to record status planning for ${params.sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const appendStatusOutcomeBestEffort = async (scheduled: boolean, reason?: string) => {
    try {
      await appendSupervisorDecisionOutcomeRecord({
        sessionFile: params.sessionFile,
        record: buildSupervisorDecisionOutcomeRecord({
          decisionId: decisionRecord.id,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          signal: scheduled ? "status_scheduled" : "status_skipped",
          payload: scheduled
            ? {
                ...buildSupervisorStatusOutcomePayload({
                  plan,
                  scheduledForRuntime: true,
                }),
                ...(earlyStatusPolicy ? { earlyStatusPolicy } : {}),
              }
            : { reason, ...(earlyStatusPolicy ? { earlyStatusPolicy } : {}) },
        }),
      });
      if (scheduled) {
        await appendSupervisorDecisionOutcomeRecord({
          sessionFile: params.sessionFile,
          record: buildSupervisorDecisionOutcomeRecord({
            decisionId: decisionRecord.id,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            signal: "first_visible_scheduled",
            payload: { kind: "status" },
          }),
        });
      }
    } catch (error) {
      logVerbose(
        `supervisor: failed to record status outcome for ${params.sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  await appendRecordBestEffort();

  if (!statusPayload) {
    const skippedPayload = buildSupervisorStatusOutcomePayload({
      plan,
      scheduledForRuntime: false,
    });
    await appendStatusOutcomeBestEffort(
      false,
      "reason" in skippedPayload ? skippedPayload.reason : undefined,
    );
    return;
  }

  try {
    const statusDeliveryStartedAt = Date.now();
    const delivered = (await params.sendStatus(statusPayload)) !== false;
    await appendStatusOutcomeBestEffort(
      delivered,
      delivered ? undefined : "status_delivery_declined",
    );
    if (delivered) {
      try {
        await appendSupervisorDecisionOutcomeRecord({
          sessionFile: params.sessionFile,
          record: buildSupervisorDecisionOutcomeRecord({
            decisionId: decisionRecord.id,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            signal: "first_visible_emitted",
            payload: {
              kind: "status",
              dispatch_to_first_visible_ms: Math.max(0, Date.now() - statusDeliveryStartedAt),
            },
          }),
        });
      } catch (error) {
        logVerbose(
          `supervisor: failed to record first-visible emission for ${params.sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    logVerbose(
      `supervisor: status delivery failed for ${params.sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
    await appendStatusOutcomeBestEffort(
      false,
      `status_delivery_error:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
