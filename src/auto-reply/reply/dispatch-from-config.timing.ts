import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createReplyTimingTracker } from "./reply-timing-tracker.js";

type ReplyHotPathLogContext = {
  channel: string;
  messageId?: number | string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
};
type ReplyHotPathLogParams = ReplyHotPathLogContext & {
  outcome: "completed" | "skipped" | "error";
  reason?: string;
};

const replyHotPathTimingLog = createSubsystemLogger("auto-reply/reply-timing");

export function createReplyHotPathTimingTracker(options: { profilerEnabled?: boolean } = {}) {
  const timing = createReplyTimingTracker<
    ReplyHotPathLogParams | (ReplyHotPathLogContext & { outcome: "milestone"; reason: string })
  >({
    log: replyHotPathTimingLog,
    enabled: options.profilerEnabled === true,
    formatMessage: (params, summary, stages) =>
      `reply hot path timings channel=${params.channel} messageId=${params.messageId ?? "unknown"} runId=${params.runId ?? "unknown"} sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} totalMs=${summary.totalMs} stages=${stages}${params.reason ? ` reason=${params.reason}` : ""}`,
    detailKeys: () => [
      "channel",
      "messageId",
      "runId",
      "sessionId",
      "sessionKey",
      "outcome",
      "reason",
    ],
  });
  return {
    measure: timing.measure,
    logIfSlow(params: ReplyHotPathLogParams, completion?: { beforeReplyResolver: boolean }) {
      if (!options.profilerEnabled && !completion?.beforeReplyResolver) {
        return;
      }
      timing.logIfSlow(params);
    },
    logPreparationIfSlow(params: ReplyHotPathLogContext) {
      const { channel, messageId, runId, sessionId, sessionKey } = params;
      timing.logIfSlow(
        {
          channel,
          messageId,
          runId,
          sessionId,
          sessionKey,
          outcome: "milestone",
          reason: "before_reply_resolver",
        },
        { repeat: true },
      );
    },
  };
}
