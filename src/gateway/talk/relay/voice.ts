import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionSettlement,
} from "../../../talk/client-voice-session-lifecycle.js";
import {
  captureClientVoiceSessionSource,
  type ClientVoiceSessionSource,
} from "../../../talk/client-voice-session-source.js";
import {
  appendRelayVoiceTranscript,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
} from "../../../talk/client-voice-session.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../talk/voice-transcript.js";
import { sleep } from "../../../utils/sleep.js";
import { drainingRelaySessions, type RelaySession } from "./state.js";

const RELAY_TRANSCRIPT_RETRY_DELAYS_MS = [0, 500, 2_000] as const;

function logRelayVoiceFailure(session: RelaySession, message: string, error: unknown): void {
  session.context.logGateway?.warn(`${message}: ${formatErrorMessage(error)}`);
}

export function ensureRelayVoiceSession(
  session: RelaySession,
  source?: ClientVoiceSessionSource,
): boolean {
  if (session.voiceSessionCreated) {
    return true;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  try {
    createOrResumeClientVoiceSession(
      {
        agentId,
        sessionKey,
        provider: session.provider,
        origin: "relay",
        voiceSessionId: session.id,
      },
      source,
    );
    session.voiceSessionCreated = true;
    return true;
  } catch (error) {
    logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
    return false;
  }
}

export function enqueueRelayVoiceTranscript(
  session: RelaySession,
  role: "user" | "assistant",
  text: string,
  retainedSource?: ClientVoiceSessionSource,
): boolean {
  const observed =
    role === "user" && !session.closing
      ? session.confirmationReadiness.observeUserTranscript(text, true)
      : undefined;
  const normalizedText = normalizeVoiceTranscriptText(text);
  if (!normalizedText) {
    return true;
  }
  if (!ensureRelayVoiceSession(session, retainedSource)) {
    session.confirmationReadiness.fail(new Error("Realtime voice session could not be recorded"));
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  const source = retainedSource ?? captureClientVoiceSessionSource(agentId);
  const settlement = captureClientVoiceSessionSettlement(source.settlementContext);
  let admission: ReturnType<typeof session.voiceTranscriptQueue.enqueue<void>>;
  try {
    admission = settlement.run(() =>
      session.voiceTranscriptQueue.enqueue(
        async () => {
          let lastError: unknown;
          for (const delayMs of RELAY_TRANSCRIPT_RETRY_DELAYS_MS) {
            if (delayMs > 0) {
              await sleep(delayMs);
            }
            try {
              await appendRelayVoiceTranscript(
                {
                  agentId,
                  sessionKey,
                  sessionTarget: { sessionKey: canonicalKey, storePath },
                  voiceSessionId: session.id,
                  entryId,
                  role,
                  text: normalizedText,
                  confirmation: observed?.confirmation ?? null,
                  ...(session.voiceConfig ? { config: session.voiceConfig } : {}),
                },
                source,
              );
              return;
            } catch (error) {
              if (hasSqliteWorkerOutcomeUnknown(error)) {
                throw error;
              }
              lastError = error;
            }
          }
          throw lastError;
        },
        { weight: normalizedText.length },
      ),
    );
  } catch (error) {
    settlement.release();
    throw error;
  }
  if (!admission.accepted) {
    settlement.release();
    session.confirmationReadiness.fail(
      new Error("Realtime voice transcript queue is closed or full"),
    );
    if (admission.reason === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return false;
  }
  session.voiceTranscriptSeq = transcriptSeq;
  void admission.completion.finally(() => settlement.release()).catch(() => {});
  void admission.completion.then(observed?.persisted, (error: unknown) => {
    session.confirmationReadiness.fail(error);
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  });
  return true;
}

export function closeRelayVoiceSession(
  session: RelaySession,
  retainedSource?: ClientVoiceSessionSource,
): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  session.voiceTranscriptQueue.seal();
  if (!ensureRelayVoiceSession(session, retainedSource)) {
    session.voiceSessionClose = Promise.resolve();
    return session.voiceSessionClose;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  const source = retainedSource ?? captureClientVoiceSessionSource(agentId);
  session.voiceSessionClose = withClientVoiceSessionSettlement(
    () =>
      session.voiceTranscriptQueue.flush().then(async () => {
        const config = session.voiceConfig ?? session.context.getRuntimeConfig();
        await closeRelayVoiceSessionRecord(
          {
            agentId,
            sessionKey,
            voiceSessionId: session.id,
            config,
          },
          source,
        );
      }),
    async (error) => {
      await session.voiceTranscriptQueue.flush();
      throw error;
    },
    source.settlementContext,
  ).catch((error: unknown) => {
    logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
  });
  drainingRelaySessions.add(session);
  void session.voiceSessionClose.finally(() => {
    drainingRelaySessions.delete(session);
  });
  return session.voiceSessionClose;
}
