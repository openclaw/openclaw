import { randomUUID } from "node:crypto";
import { readErrorName } from "../../../infra/errors.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../talk/agent-consult-tool.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import type { TalkEventInput } from "../../../talk/talk-session-controller.js";
import type { TalkAgentConsultRequest } from "../client-agent-consult.types.js";
import type { TalkRealtimeRelayEventPayload } from "./state.js";

type RelayAgentConsultRunner = RealtimeVoiceAgentConsultRunner & {
  adoptCompletionClaims: () => void;
  claimAppend: () => boolean;
  claimFailureAppend: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: RealtimeVoiceAgentConsultRunner;
};

type RelayAgentConsultLifecycle = {
  started: (callId: string) => void;
  settled: (callId: string, outcome: "completed" | "cancelled" | "failed") => void;
};

type RelayAgentConsultLifecycleParams = {
  relaySessionId: string;
  harness: { ensureTurn(): string };
  emit: (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEventInput) => void;
};

function createTalkRealtimeRelayAgentConsultLifecycle(
  params: RelayAgentConsultLifecycleParams,
): RelayAgentConsultLifecycle {
  const emitLifecycle = (
    callId: string,
    outcome: "working" | "completed" | "cancelled" | "failed",
  ) => {
    params.emit(
      { relaySessionId: params.relaySessionId, type: "talkEvent" },
      {
        type:
          outcome === "working" ? "tool.call" : outcome === "failed" ? "tool.error" : "tool.result",
        callId,
        turnId: params.harness.ensureTurn(),
        payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: outcome },
        ...(outcome === "working" ? {} : { final: true }),
      },
    );
  };
  return {
    started: (callId) => emitLifecycle(callId, "working"),
    settled: (callId, outcome) => emitLifecycle(callId, outcome),
  };
}

export function bindTalkRealtimeRelayAgentConsult(
  runPrompt: RelayAgentConsultRunner,
  isCurrent: () => boolean,
  waitForTranscript: (signal?: AbortSignal) => Promise<void>,
  lifecycleParams?: RelayAgentConsultLifecycleParams,
) {
  const lifecycle = lifecycleParams
    ? createTalkRealtimeRelayAgentConsultLifecycle(lifecycleParams)
    : undefined;
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
  const runWithLifecycle = async (request: TalkAgentConsultRequest) => {
    const run = bindReadiness(runPrompt, "Realtime gateway-relay session is closed");
    if (!lifecycle || !isCurrent()) {
      return await run(request);
    }
    const callId = `native-consult-${randomUUID()}`;
    lifecycle.started(callId);
    let outcome: "completed" | "cancelled" | "failed" = "completed";
    try {
      return await run(request);
    } catch (error) {
      outcome =
        request.signal?.aborted || readErrorName(error) === "AbortError" ? "cancelled" : "failed";
      throw error;
    } finally {
      if (isCurrent()) {
        lifecycle.settled(callId, outcome);
      }
    }
  };
  const lifecycleMethods = {
    adoptCompletionClaims: () => runPrompt.adoptCompletionClaims(),
    claimAppend: () => {
      const current = isCurrent();
      const claimed = runPrompt.claimAppend();
      return current && claimed;
    },
    claimFailureAppend: () => {
      const current = isCurrent();
      const claimed = runPrompt.claimFailureAppend();
      return current && claimed;
    },
    revokeRequesterFinal: () => runPrompt.revokeRequesterFinal?.(),
    ...(steer
      ? {
          steer: bindReadiness(steer, "Realtime relay session is no longer active"),
        }
      : {}),
  };
  return Object.assign(runWithLifecycle, lifecycleMethods);
}
