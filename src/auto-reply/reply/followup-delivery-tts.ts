import { logVerbose } from "../../globals.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import { prepareTtsPreferences } from "../../tts/tts-preferences.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReplyPayloadStatusNotice, type ReplyPayload } from "../reply-payload.js";
import { maybeApplyTtsToReplyPayload } from "./dispatch-from-config.payloads.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./reply-agent-turn-preparation.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import { beginReplyOperationFinalizationWork } from "./reply-run-finalization-lease.js";

export function createFollowupSpeechPreparer({
  turn,
  defaults,
  kind,
}: {
  turn: AdmittedFollowupTurn;
  defaults: FollowupRunnerParams;
  kind: ReplyDispatchKind;
}) {
  let preparedTtsPreferences = defaults.opts?.preparedTtsPreferences;
  return async (payload: ReplyPayload, route: "origin" | "dispatcher") => {
    if (payload.isReasoning || payload.isCommentary || isReplyPayloadStatusNotice(payload)) {
      return payload;
    }
    preparedTtsPreferences ??= await prepareTtsPreferences();
    const channel =
      route === "origin" ? turn.queued.originatingChannel : turn.queued.run.messageProvider;
    const context = {
      cfg: turn.config,
      preparedTtsPreferences,
      ttsAuto: turn.session.current()?.ttsAuto,
      agentId: turn.queued.run.agentId,
      channelId: normalizeMessageChannel(channel) ?? channel,
      accountId:
        route === "origin" ? turn.queued.originatingAccountId : turn.queued.run.agentAccountId,
    };
    if (!shouldAttemptTtsPayload(context)) {
      return payload;
    }
    turn.operation.abortSignal.throwIfAborted();
    turn.queued.operatorAuthority?.assertCurrent();
    const finish = beginReplyOperationFinalizationWork(turn.operation, RUN_STALE_TAKEOVER_MS);
    let prepared = payload;
    try {
      prepared = await maybeApplyTtsToReplyPayload({
        ...context,
        channel: context.channelId,
        payload,
        kind,
        inboundAudio:
          turn.queued.currentInboundAudio === true || turn.operation.acceptedSteeredInboundAudio,
      });
      turn.operation.watchdog.progress("finalization", "reply:tts_prepared");
    } catch {
      logVerbose("followup queue: speech preparation failed; delivering the original payload");
    } finally {
      finish();
    }
    turn.operation.abortSignal.throwIfAborted();
    turn.queued.operatorAuthority?.assertCurrent();
    return prepared;
  };
}
