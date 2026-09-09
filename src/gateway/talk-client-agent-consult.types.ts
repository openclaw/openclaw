import type { RealtimeVoiceAgentConsultRunner } from "../talk/provider-types.js";

export type TalkAgentConsultLifecycleMethods = {
  adoptCompletionClaims?: () => void;
  claimAppend?: () => boolean;
  claimFailureAppend?: () => boolean;
  steer?: RealtimeVoiceAgentConsultRunner;
};

export type LifecycleBoundTalkAgentConsult = ((
  args: unknown,
  signal: AbortSignal,
  ready?: () => Promise<void>,
  assertCurrent?: () => void,
) => Promise<{ text: string }>) &
  TalkAgentConsultLifecycleMethods;

export type ReusableTalkAgentConsult = (
  args: unknown,
  signal: AbortSignal,
  assertCurrent?: () => void,
) => Promise<{ text: string }>;
