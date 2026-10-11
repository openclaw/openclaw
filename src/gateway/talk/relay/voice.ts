import { releaseSessionSourceAuthorities } from "../../../config/sessions/session-source-authority.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { withClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import { captureClientVoiceSessionSource } from "../../../talk/client-voice-session-source.js";
import {
  captureClientVoiceSessionWriter,
  type ClientVoiceSessionWriter,
} from "../../../talk/client-voice-session-write.js";
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

export function captureRelayVoiceSessionSource(session: RelaySession) {
  return (session.voiceSessionSource ??= captureClientVoiceSessionSource(
    session.sessionTarget.agentId,
  ));
}

export function ensureRelayVoiceSession(session: RelaySession): Promise<boolean> {
  const fail = (error: unknown) => {
    if (!hasSqliteWorkerOutcomeUnknown(error)) {
      session.voiceSessionCreation = undefined;
    }
    logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
    return false;
  };
  try {
    const source = captureRelayVoiceSessionSource(session);
    if (session.voiceSessionCreated) {
      source.assertCurrent();
      return Promise.resolve(true);
    }
    const { agentId, sessionKey } = session.sessionTarget;
    session.voiceSessionCreation ??= withClientVoiceSessionSettlement(
      async () => {
        let writer: ClientVoiceSessionWriter | undefined;
        const errors: unknown[] = [];
        try {
          writer = captureClientVoiceSessionWriter({ agentId, physicalSource: source });
          await createOrResumeClientVoiceSession(
            {
              agentId,
              sessionKey,
              provider: session.provider,
              origin: "relay",
              voiceSessionId: session.id,
            },
            writer,
          );
          const committed = writer.source;
          committed.assertCurrent();
          session.voiceSessionSource = committed;
          session.voiceSessionCreated = true;
          return true;
        } catch (error) {
          errors.push(error);
          if (writer && !hasSqliteWorkerOutcomeUnknown(error)) {
            try {
              // Admission may have created the file before the voice write was refused.
              const admitted = writer.source;
              admitted.assertCurrent();
              session.voiceSessionSource = admitted;
            } catch {
              // Keep the original descriptor fenced when its creator cannot certify the file.
            }
          }
          throw error;
        } finally {
          await releaseSessionSourceAuthorities(writer ? [writer] : [], errors);
        }
      },
      undefined,
      source.settlementContext,
    ).catch(fail);
    return session.voiceSessionCreation;
  } catch (error) {
    return Promise.resolve(fail(error));
  }
}

export function enqueueRelayVoiceTranscript(
  session: RelaySession,
  role: "user" | "assistant",
  text: string,
): boolean {
  const observed =
    role === "user" && !session.closing
      ? session.confirmationReadiness.observeUserTranscript(text, true)
      : undefined;
  const normalizedText = normalizeVoiceTranscriptText(text);
  if (!normalizedText) {
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  let accepted = false;
  let rejection: string | undefined;
  const reportFailure = (error: unknown) => {
    session.confirmationReadiness.fail(error);
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  };
  const completion = withClientVoiceSessionSettlement(
    async () => {
      captureRelayVoiceSessionSource(session);
      const admission = session.voiceTranscriptQueue.enqueue(
        async () => {
          if (!(await ensureRelayVoiceSession(session))) {
            throw new Error("Realtime voice session could not be recorded");
          }
          const writer = captureClientVoiceSessionWriter({
            agentId,
            physicalSource: captureRelayVoiceSessionSource(session),
          });
          try {
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
                  writer,
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
          } finally {
            await writer.release();
          }
        },
        { weight: normalizedText.length },
      );
      accepted = admission.accepted;
      if (!admission.accepted) {
        rejection = admission.reason;
        return;
      }
      session.voiceTranscriptSeq = transcriptSeq;
      await admission.completion.then(observed?.persisted, reportFailure);
    },
    undefined,
    session.voiceSessionSource?.settlementContext,
  );
  void completion.catch(reportFailure);
  if (!accepted) {
    session.confirmationReadiness.fail(
      new Error("Realtime voice transcript queue is closed or full"),
    );
    if (rejection === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return false;
  }
  return true;
}

export function closeRelayVoiceSession(session: RelaySession): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  session.voiceTranscriptQueue.seal();
  const { agentId, sessionKey } = session.sessionTarget;
  session.voiceSessionClose = withClientVoiceSessionSettlement(
    async () => {
      try {
        captureRelayVoiceSessionSource(session);
        await ensureRelayVoiceSession(session);
      } catch (error) {
        await session.voiceTranscriptQueue.flush();
        throw error;
      }
      await session.voiceTranscriptQueue.flush();
      if (!session.voiceSessionCreated) {
        return;
      }
      const writer = captureClientVoiceSessionWriter({
        agentId,
        physicalSource: captureRelayVoiceSessionSource(session),
      });
      try {
        const config = session.voiceConfig ?? session.context.getRuntimeConfig();
        await closeRelayVoiceSessionRecord(
          {
            agentId,
            sessionKey,
            voiceSessionId: session.id,
            config,
          },
          writer,
        );
      } finally {
        await writer.release();
      }
    },
    async (error) => {
      await session.voiceTranscriptQueue.flush();
      throw error;
    },
    session.voiceSessionSource?.settlementContext,
  ).catch((error: unknown) => {
    logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
  });
  drainingRelaySessions.add(session);
  void session.voiceSessionClose.finally(() => {
    drainingRelaySessions.delete(session);
  });
  return session.voiceSessionClose;
}
