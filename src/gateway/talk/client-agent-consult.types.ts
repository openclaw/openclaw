import type { SessionControllerInput } from "../../sessions/session-controller.contracts.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../talk/provider-types.js";

export type TalkRequesterFinalBinding = {
  append: (text: string) => boolean;
};

export type TalkAgentConsultRequest = Parameters<RealtimeVoiceAgentConsultRunner>[0] & {
  requesterFinal?: TalkRequesterFinalBinding;
};

export type TalkAgentConsultSource = "tool-call" | "native-delegation";

export type TalkAgentConsultLifecycleMethods = {
  adoptCompletionClaims?: () => void;
  claimAppend?: () => boolean;
  claimFailureAppend?: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: RealtimeVoiceAgentConsultRunner;
};

export type LifecycleBoundTalkAgentConsult = ((
  args: unknown,
  signal: AbortSignal,
  ready?: () => Promise<void>,
  assertCurrent?: () => void,
  requesterFinal?: TalkRequesterFinalBinding,
  source?: TalkAgentConsultSource,
) => Promise<{ text: string; yielded?: true }>) &
  TalkAgentConsultLifecycleMethods;

export type ReusableTalkAgentConsult = (
  args: unknown,
  signal: AbortSignal,
  assertCurrent?: () => void,
  source?: TalkAgentConsultSource,
  /** Mailbox input reserved when the tool call arrived; the run adopts it. */
  sourceInput?: SessionControllerInput,
) => Promise<{ text: string }>;
