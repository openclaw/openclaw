import type { RealtimeVoiceAgentConsultRunner } from "../talk/provider-types.js";

export type TalkRequesterFinalBinding = {
  append: (text: string) => boolean;
};

export type TalkAgentConsultRequest = Parameters<RealtimeVoiceAgentConsultRunner>[0] & {
  requesterFinal?: TalkRequesterFinalBinding;
};

export type TalkRequesterFinalRegistration = {
  releaseProvisional: () => void;
  revoke: () => void;
};

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
) => Promise<{ text: string; yielded?: true }>) &
  TalkAgentConsultLifecycleMethods;

export type ReusableTalkAgentConsult = (
  args: unknown,
  signal: AbortSignal,
  assertCurrent?: () => void,
) => Promise<{ text: string }>;
