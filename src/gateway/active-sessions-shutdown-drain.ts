import { buildSessionEndHookPayload } from "../auto-reply/reply/session-hooks.js";
import { logVerbose } from "../globals.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createSessionEndTranscriptSourceLease } from "../plugins/session-end-transcript.js";
import { settlesWithin } from "../shared/settle-within.js";
import {
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
} from "./active-sessions-shutdown-tracker.js";
import { createClosedSessionTranscriptSource } from "./session-end-transcript-reader.js";
import { resolveStableSessionEndTranscript } from "./session-transcript-files.fs.js";

export async function drainActiveSessionsForShutdown(params: {
  reason: "shutdown" | "restart";
  totalTimeoutMs?: number;
}): Promise<{ emittedSessionIds: string[]; timedOut: boolean }> {
  const tracked = listActiveSessionsForShutdown();
  if (tracked.length === 0) {
    return { emittedSessionIds: [], timedOut: false };
  }
  const totalTimeoutMs = Math.max(100, Math.floor(params.totalTimeoutMs ?? 2_000));
  const emittedSessionIds: string[] = [];
  const transcriptLeases: Array<{ revoke(): void }> = [];
  const hookRunner = getGlobalHookRunner();
  let settledEmissions = 0;
  // Start all emissions before the bounded aggregate so one slow plugin cannot
  // prevent later tracked sessions from receiving session_end.
  const drain = Promise.allSettled(
    tracked.map(async (entry) => {
      try {
        forgetActiveSessionForShutdown(entry.sessionId);
        emittedSessionIds.push(entry.sessionId);
        if (!hookRunner?.hasHooks("session_end")) {
          return;
        }
        const transcript = resolveStableSessionEndTranscript({
          sessionId: entry.sessionId,
          storePath: entry.storePath,
          sessionFile: entry.sessionFile,
          agentId: entry.agentId,
        });
        const transcriptLease = createSessionEndTranscriptSourceLease(
          createClosedSessionTranscriptSource({
            agentId: entry.agentId,
            sessionId: entry.sessionId,
            sessionKey: entry.sessionKey,
            storePath: entry.storePath,
          }),
        );
        transcriptLeases.push(transcriptLease);
        const payload = buildSessionEndHookPayload({
          sessionId: entry.sessionId,
          sessionKey: entry.sessionKey,
          agentId: entry.agentId,
          reason: params.reason,
          sessionFile: transcript.sessionFile,
          transcriptArchived: transcript.transcriptArchived,
          endedTranscript: transcriptLease.source,
        });
        await hookRunner.runSessionEnd(payload.event, payload.context);
      } catch (err) {
        logVerbose(`session_end hook failed during shutdown drain: ${String(err)}`);
      } finally {
        settledEmissions++;
      }
    }),
  );
  const timedOut = !(await settlesWithin(drain, totalTimeoutMs));
  for (const lease of transcriptLeases) {
    lease.revoke();
  }
  if (timedOut) {
    logVerbose(
      `shutdown session-end drain timed out after ${totalTimeoutMs}ms with ${tracked.length - settledEmissions} session_end handler(s) still pending`,
    );
  }
  return { emittedSessionIds, timedOut };
}
