import { publishTranscriptUpdate } from "../../../config/sessions/session-accessor.sqlite-events.js";
import { appendExpectedSessionTranscriptTurn } from "../../../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { withClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import type { ClientVoiceSessionSource } from "../../../talk/client-voice-session-source.js";
import { registerClientVoiceConsultRun } from "../../../talk/client-voice-session.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import { abortChatRunById } from "../../chat-abort.js";
import {
  isTalkAgentConsultFinalMessage,
  prepareTalkAgentConsultTranscript,
} from "../agent-consult-transcript.js";
import type { TalkAgentConsultRequest } from "../client-agent-consult.types.js";
import {
  hasRelayAgentRunRegistrations,
  type RelayAgentRun,
  type RelayAgentRunRegistration,
  type RelaySession,
} from "./state.js";
import { captureRelayVoiceSessionSource, ensureRelayVoiceSession } from "./voice.js";

type RelayAgentConsultRunner = RealtimeVoiceAgentConsultRunner & {
  adoptCompletionClaims: () => void;
  claimAppend: () => boolean;
  claimFailureAppend: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: RealtimeVoiceAgentConsultRunner;
};

export function bindTalkRealtimeRelayAgentConsult(
  runPrompt: RelayAgentConsultRunner,
  isCurrent: () => boolean,
  waitForTranscript: (signal?: AbortSignal) => Promise<void>,
) {
  const bindReadiness =
    (runner: RealtimeVoiceAgentConsultRunner, closedMessage: string) =>
    async (request: TalkAgentConsultRequest) => {
      if (!isCurrent()) {
        throw new Error(closedMessage);
      }
      await waitForTranscript(request.signal);
      if (!isCurrent()) {
        throw new Error(closedMessage);
      }
      return await runner(request);
    };
  const steer = runPrompt.steer;
  const claimForCurrentOwner = (claim: "claimAppend" | "claimFailureAppend") => {
    const current = isCurrent();
    const claimed = runPrompt[claim]();
    return current && claimed;
  };
  const lifecycleMethods = {
    adoptCompletionClaims: () => runPrompt.adoptCompletionClaims(),
    claimAppend: () => claimForCurrentOwner("claimAppend"),
    claimFailureAppend: () => claimForCurrentOwner("claimFailureAppend"),
    revokeRequesterFinal: () => runPrompt.revokeRequesterFinal?.(),
    ...(steer
      ? {
          steer: bindReadiness(steer, "Realtime relay session is no longer active"),
        }
      : {}),
  };
  return Object.assign(
    bindReadiness(runPrompt, "Realtime gateway-relay session is closed"),
    lifecycleMethods,
  );
}

export function createRelayAgentRunRegistration(
  getRelaySession: (relaySessionId: string, connId: string) => RelaySession,
) {
  return async function registerTalkRealtimeRelayAgentRun(params: {
    relaySessionId: string;
    connId: string;
    sessionKey: string;
    runId: string;
    callId?: string;
    transcriptSessionId?: string;
    assertCurrent?: () => void;
    registerVoice?: (
      assertCurrent: () => void,
      physicalSource: ClientVoiceSessionSource,
      onRegistered: (release: () => void) => void,
    ) => Promise<void>;
  }): Promise<RelayAgentRunRegistration> {
    const session = getRelaySession(params.relaySessionId, params.connId);
    const callId = params.callId?.trim();
    const previous = session.activeAgentRuns.get(params.runId);
    const run: RelayAgentRun =
      previous?.sessionKey === params.sessionKey
        ? previous
        : { runId: params.runId, sessionKey: params.sessionKey };
    const chat = session.context.chatAbortControllers.get(params.runId);
    const chatGeneration = chat?.lifecycleGeneration;
    let installed = false;
    let transcriptSession: { sessionId: string; lifecycleRevision?: string } | undefined;
    const ownsSlot = () =>
      callId
        ? session.activeAgentToolCalls.get(callId) === registration
        : run.standalone === registration;
    const ownsChat = () =>
      session.context.chatAbortControllers.get(params.runId) === chat &&
      (!chat ||
        (!chat.controller.signal.aborted &&
          chat.registrationCleanupRequested !== true &&
          chat.lifecycleGeneration === chatGeneration &&
          (chatGeneration === undefined ||
            isAgentEventLifecycleGenerationCurrent(chatGeneration))));
    const isCurrent = () =>
      ownsChat() && session.activeAgentRuns.get(params.runId) === run && ownsSlot();
    const canReleaseVoice = () =>
      isCurrent() && !hasRelayAgentRunRegistrations(session, run, registration);
    const release = () => {
      if (!ownsSlot()) {
        return;
      }
      if (callId) {
        session.activeAgentToolCalls.delete(callId);
      } else {
        delete run.standalone;
      }
      if (
        session.activeAgentRuns.get(params.runId) === run &&
        !hasRelayAgentRunRegistrations(session, run)
      ) {
        session.activeAgentRuns.delete(params.runId);
        run.releaseVoice?.();
      }
    };
    const registration: RelayAgentRunRegistration = {
      run,
      prepareTranscript(message, sourceText) {
        if (run.detached) {
          return message;
        }
        if (transcriptSession && isTalkAgentConsultFinalMessage(message)) {
          const answer = structuredClone(message);
          session.unspokenAnswers ??= new Map();
          const admitted = transcriptSession;
          session.unspokenAnswers.set(params.runId, async (writer) => {
            const { agentId, canonicalKey: sessionKey, storePath } = session.sessionTarget;
            const assertCurrent = composeSessionSourceAssertion(
              [writer.assertCurrent],
              (assertSource) => {
                assertSource();
                session.runAuthority?.assertCurrent();
                session.sessionTarget.assertCurrent(session.context.getRuntimeConfig());
              },
            );
            const target = {
              agentId,
              sessionKey,
              storePath,
              sessionId: admitted.sessionId,
              env: writer.options.env,
            };
            const eventId = `talk-detached:${session.id}:${params.runId}`;
            const result = await appendExpectedSessionTranscriptTurn(target, {
              keyFormat: "agent-qualified",
              expectedSessionId: admitted.sessionId,
              selectedSessionId: admitted.sessionId,
              selectedLifecycleRevision: admitted.lifecycleRevision,
              sessionFile: sessionKey,
              assertCurrent,
              messages: [
                {
                  eventId,
                  message: {
                    ...answer,
                    usage: undefined,
                    idempotencyKey: eventId,
                    excludeFromContext: true,
                  },
                },
              ],
            });
            if (result.rejectedReason) {
              throw new Error("Realtime relay answer session changed before append");
            }
            for (const appended of result.appendedMessages) {
              await publishTranscriptUpdate(target, {
                message: appended.message,
                messageId: appended.messageId,
              });
            }
          });
        }
        return prepareTalkAgentConsultTranscript(message, sourceText);
      },
      isCurrent,
      release,
      abortIfCurrent: () => {
        const uninstalled =
          !installed &&
          !session.activeAgentRuns.has(params.runId) &&
          (!callId || !session.activeAgentToolCalls.has(callId));
        if (
          (canReleaseVoice() || uninstalled) &&
          chat &&
          session.context.chatAbortControllers.get(params.runId) === chat
        ) {
          abortChatRunById(session.context, {
            runId: params.runId,
            sessionKey: params.sessionKey,
            stopReason: "voice session binding failed",
          });
        }
      },
    };
    const assertCallerCurrent = () => {
      params.assertCurrent?.();
      if (!ownsChat()) {
        throw new Error("Realtime relay run registration changed while waiting");
      }
      if (getRelaySession(params.relaySessionId, params.connId) !== session) {
        throw new Error("Realtime relay session changed during run registration");
      }
      if (
        callId &&
        (session.toolCalls.isAgentCompleted(callId) || session.toolCalls.hasCancelled(callId))
      ) {
        throw new Error("Realtime provider cancelled the tool call before run registration");
      }
    };
    const assertCurrent = () => {
      assertCallerCurrent();
      if (!isCurrent()) {
        throw new Error("Realtime relay run registration changed while waiting");
      }
    };
    try {
      const source = captureRelayVoiceSessionSource(session);
      return await withClientVoiceSessionSettlement(
        async () => {
          assertCallerCurrent();
          if (callId && !session.toolCalls.tryAdmit([callId])) {
            throw new Error("Realtime relay tool-call session limit exceeded");
          }
          session.activeAgentRuns.set(params.runId, run);
          if (callId) {
            session.activeAgentToolCalls.set(callId, registration);
          } else {
            run.standalone = registration;
          }
          installed = true;
          if (!(await ensureRelayVoiceSession(session))) {
            throw new Error("Realtime relay voice session could not be created for agent consult");
          }
          assertCurrent();
          const { agentId, sessionKey } = session.sessionTarget;
          const physicalSource = captureRelayVoiceSessionSource(session);
          physicalSource.assertCurrent();
          if (params.transcriptSessionId) {
            const sessionId = params.transcriptSessionId;
            transcriptSession = await withSessionEntryReadOnlyInWorker(
              {
                agentId,
                sessionKey: params.sessionKey,
                storePath: session.sessionTarget.storePath,
                env: physicalSource.options.env,
              },
              assertCurrent,
              async (read) => {
                if (!read.ok) {
                  throw read.error;
                }
                if (read.value?.sessionId !== sessionId) {
                  throw new Error("Realtime relay transcript changed before agent dispatch");
                }
                return { sessionId, lifecycleRevision: read.value.lifecycleRevision };
              },
            );
          }
          const onRegistered = (releaseVoice: () => void) => {
            run.releaseVoice = releaseVoice;
          };
          if (params.registerVoice) {
            await params.registerVoice(assertCurrent, physicalSource, onRegistered);
          } else {
            await registerClientVoiceConsultRun({
              agentId,
              sessionKey,
              voiceSessionId: session.id,
              runId: params.runId,
              assertCurrent,
              physicalSource,
              onRegistered,
            });
          }
          assertCurrent();
          return registration;
        },
        undefined,
        source.settlementContext,
      );
    } catch (error) {
      registration.abortIfCurrent();
      release();
      throw error;
    }
  };
}
