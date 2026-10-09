import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import type { TalkAgentConsultRequest } from "../client-agent-consult.types.js";

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
