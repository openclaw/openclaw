import type {
  ReplyToolAuthorityOverlay,
  SessionControllerInput,
} from "../../sessions/session-controller.contracts.js";
import type { controlTalkAgentRun } from "../../talk/agent-run-control.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceGatewayControl,
} from "../../talk/provider-types.js";
import type { GatewayRequestContext } from "../server-methods/shared-types.js";
import type { TalkRunCancelContext } from "./realtime-run-control.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

export type TalkRequesterFinalBinding = {
  append: (text: string) => boolean;
};

export type TalkAgentConsultRequest = Parameters<RealtimeVoiceAgentConsultRunner>[0] & {
  requesterFinal?: TalkRequesterFinalBinding;
};

export type TalkAgentConsultSource = "tool-call" | "native-delegation";

type TalkAgentConsultLifecycleMethods = {
  adoptCompletionClaims?: () => void;
  claimAppend?: () => boolean;
  claimFailureAppend?: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: RealtimeVoiceAgentConsultRunner;
};

type LifecycleBoundTalkAgentConsult = ((
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

type GatewayTalkAgentConsultRunner = (
  request: TalkAgentConsultRequest,
) => ReturnType<RealtimeVoiceAgentConsultRunner>;

export type GatewayControlOwner = {
  readonly signal: AbortSignal;
  adoptProvider: (closeProvider: () => Promise<void>) => Promise<void>;
  activate: () => void;
  assertOpen: () => void;
  close: (options?: {
    preserveLogicalSession?: boolean;
    preserveRuns?: boolean;
    skipProvider?: boolean;
  }) => Promise<void>;
  connId: string;
  control: RealtimeVoiceGatewayControl & Required<Pick<RealtimeVoiceGatewayControl, "bindControl">>;
  runAgentConsult: GatewayTalkAgentConsultRunner & TalkAgentConsultLifecycleMethods;
  sendSpeech: (text: string) => void;
  sessionTarget: PreparedTalkSessionTarget;
  voiceSessionId: string;
};

export type GatewayControlCommands = Parameters<
  NonNullable<RealtimeVoiceGatewayControl["bindControl"]>
>[0];

export type TalkClientGatewayControlOptions = {
  voiceSessionId: string;
  providerId?: string;
  supportsToolCalls?: boolean;
  controlSource?: "delegation" | "transcript";
  sessionTarget: PreparedTalkSessionTarget;
  connId: string;
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "logGateway"> & TalkRunCancelContext;
  assertConnectionOpen?: () => void;
  runToolAgentConsult: ReusableTalkAgentConsult;
  runAgentConsult: LifecycleBoundTalkAgentConsult;
  appendTranscript: (entry: {
    entryId: string;
    role: "user" | "assistant";
    text: string;
  }) => Promise<void>;
  flushTranscript: () => Promise<void>;
  closeLogicalSession: () => Promise<void>;
  withCloseSettlement?: (run: () => Promise<void>) => Promise<void>;
  controlAgentRun?: typeof controlTalkAgentRun;
  getToolAuthorityOverlay?: (source?: "reply" | "attempt") => Promise<ReplyToolAuthorityOverlay>;
};
