import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, onTestFinished, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { extractText } from "../../ui/src/lib/chat/message-extract.ts";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import * as transcriptTurns from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import * as sleep from "../utils/sleep.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createIdleRelayProvider } from "./talk/relay/index.test-support.js";
import { closeRelaySession, flushTalkRealtimeRelayVoiceWrites } from "./talk/relay/operations.js";
import { createTalkRealtimeRelaySession } from "./talk/relay/session-create.js";
import { relaySessions } from "./talk/relay/state.js";
import { enqueueRelayVoiceTranscript } from "./talk/relay/voice.js";
import { rememberUnifiedTalkSession } from "./talk/session-registry.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

export async function runTalkRelayCloseHistory({
  disposition,
  afterFinal,
  spokenReplacement,
  pendingFollowUp,
  unknownAppendOutcome,
  scope,
  sessionKey,
  connectionId,
  context,
  runEmbeddedAgent,
  rpc,
  waitForDispatchEnd,
  drainPublications,
  historyMessages,
  liveMessages,
  answer,
  args,
}: {
  disposition: "abort" | "detach" | undefined;
  afterFinal: boolean;
  spokenReplacement: boolean;
  pendingFollowUp: boolean;
  unknownAppendOutcome?: "before" | "after";
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string };
  sessionKey: string;
  connectionId: string;
  context: GatewayRequestContext;
  runEmbeddedAgent: MockInstance<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;
  rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  waitForDispatchEnd: () => Promise<void>;
  drainPublications: () => Promise<void>;
  historyMessages: () => Promise<unknown[]>;
  liveMessages: () => unknown[];
  answer: string;
  args: Record<string, unknown>;
}) {
  const { agentId, sessionId, storePath, sessionKey: canonicalKey } = scope();
  let modelStarted = createDeferred();
  let releaseModel = createDeferred();
  const finalCommitted = createDeferred();
  const spokenAnswer = "SPOKEN_DETACH_171310: The requested note is saved.";
  const followUpAnswer = "FOLLOWUP_DETACH_171310: The next requested note is saved.";
  let modelCalls = 0;
  runEmbeddedAgent.mockImplementation(async (params) => {
    const modelAnswer = modelCalls++ === 0 ? answer : followUpAnswer;
    await params.userTurnTranscriptRecorder?.persistApproved();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    params.onExecutionPhase?.({ phase: "model_call_started" });
    modelStarted.resolve();
    await releaseModel.promise;
    params.abortSignal?.throwIfAborted();
    const assistant = makeAgentAssistantMessage({ content: [{ type: "text", text: modelAnswer }] });
    assistant.usage = { ...assistant.usage, input: 10, totalTokens: 10 };
    guardSessionManager(SessionManager.open(scope()), {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      runId: params.runId,
      prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
    }).appendMessage(assistant);
    finalCommitted.resolve();
    return {
      // Match the embedded runner's ownership receipt for the row just persisted.
      payloads: buildEmbeddedRunPayloads({
        assistantTexts: [modelAnswer],
        lastAssistant: assistant,
        assistantTranscriptOwned: true,
        sessionKey: canonicalKey,
      }),
      meta: { durationMs: 0 },
    };
  });
  const target = await prepareTalkSessionTarget(getRuntimeConfig(), sessionKey);
  const relay = createTalkRealtimeRelaySession({
    context,
    connId: connectionId,
    provider: createIdleRelayProvider(),
    providerConfig: {},
    controlSource: "transcript",
    sessionTarget: target,
    instructions: "Test relay",
    tools: [],
  });
  rememberUnifiedTalkSession(relay.relaySessionId, {
    kind: "realtime-relay",
    connId: connectionId,
    relaySessionId: relay.relaySessionId,
    sessionTarget: target,
  });
  try {
    const ack = await rpc("talk.client.toolCall", {
      sessionKey,
      relaySessionId: relay.relaySessionId,
      voiceSessionId: relay.relaySessionId,
      callId: "close-held-relay-consult",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args,
    });
    await Promise.race([
      modelStarted.promise,
      getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [canonicalKey, sessionId],
      }),
    ]);
    const run = expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "relay model invocation");
    const signal = expectDefined(run.abortSignal, "relay run cancellation");
    expect(run).toMatchObject({ agentId, sessionId, sessionKey: canonicalKey });
    expect(signal.aborted).toBe(false);
    expect(ack.runId).toBe(run.runId);
    if (afterFinal) {
      releaseModel.resolve();
      await finalCommitted.promise;
      await waitForDispatchEnd();
    }
    if (pendingFollowUp) {
      modelStarted = createDeferred();
      releaseModel = createDeferred();
      await rpc("talk.client.toolCall", {
        sessionKey,
        relaySessionId: relay.relaySessionId,
        voiceSessionId: relay.relaySessionId,
        callId: "pending-follow-up-consult",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "Save the next requested note." },
      });
      await modelStarted.promise;
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
      const owner = expectDefined(relaySessions.get(relay.relaySessionId), "live relay");
      expect(enqueueRelayVoiceTranscript(owner, "assistant", "Let me check the next note.")).toBe(
        true,
      );
      await flushTalkRealtimeRelayVoiceWrites({
        relaySessionId: relay.relaySessionId,
        connId: connectionId,
      });
      if (spokenReplacement) {
        releaseModel.resolve();
        await waitForDispatchEnd();
      }
    }
    if (spokenReplacement) {
      const owner = expectDefined(relaySessions.get(relay.relaySessionId), "live relay");
      expect(enqueueRelayVoiceTranscript(owner, "assistant", spokenAnswer)).toBe(true);
      await flushTalkRealtimeRelayVoiceWrites({
        relaySessionId: relay.relaySessionId,
        connId: connectionId,
      });
    }
    const transcriptBeforeClose = loadTranscriptEventsSync(scope());
    if (unknownAppendOutcome) {
      const append = transcriptTurns.appendExpectedSessionTranscriptTurn;
      const injected = vi
        .spyOn(transcriptTurns, "appendExpectedSessionTranscriptTurn")
        .mockImplementationOnce(async (...params) => {
          if (unknownAppendOutcome === "after") {
            await append(...params);
          }
          throw new SqliteWorkerError("Detached answer outcome unknown", "outcome-unknown");
        });
      const delay = vi.spyOn(sleep, "sleep").mockResolvedValue();
      onTestFinished(() => {
        injected.mockRestore();
        delay.mockRestore();
      });
    }
    await rpc("talk.session.close", {
      sessionId: relay.relaySessionId,
      ...(disposition ? { disposition } : {}),
    });
    expect(signal.aborted).toBe(disposition !== "detach");
    releaseModel.resolve();
    await waitForDispatchEnd();
    await drainPublications();
    const expectedAnswers = spokenReplacement ? [spokenAnswer] : [];
    if (disposition === "detach") {
      expectedAnswers.push(answer);
    }
    if (pendingFollowUp) {
      expectedAnswers.push(followUpAnswer);
    }
    expect(
      (await historyMessages())
        .map(extractText)
        .filter((text) => text === answer || text === spokenAnswer || text === followUpAnswer),
    ).toEqual(expectedAnswers);
    const transcriptAfterClose = loadTranscriptEventsSync(scope());
    expect(transcriptAfterClose.slice(0, transcriptBeforeClose.length)).toEqual(
      transcriptBeforeClose,
    );
    const stored = transcriptAfterClose.flatMap((event) => {
      const message = asOptionalRecord(asOptionalRecord(event)?.message);
      return message && extractText(message) === answer ? [message] : [];
    });
    expect(stored.map(extractText)).toEqual(
      disposition === "detach" ? (afterFinal ? [answer, answer] : [answer]) : [],
    );
    if (disposition === "detach") {
      expect(liveMessages().map(extractText)).toContain(answer);
      expect(stored.at(-1)?.display).toBeUndefined();
      if (afterFinal) {
        expect(stored[0]?.display).toBe(false);
        expect(stored[1]?.excludeFromContext).toBe(true);
        expect(stored[0]?.usage).toMatchObject({ input: 10, totalTokens: 10 });
        expect(stored[1]?.usage).toBeUndefined();
      }
    }
  } finally {
    const active = relaySessions.get(relay.relaySessionId);
    if (active) {
      await closeRelaySession(active, "completed");
    }
    releaseModel.resolve();
  }
}
