import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceGatewayControl,
} from "../../talk/provider-types.js";
import type {
  TalkAgentConsultLifecycleMethods,
  TalkAgentConsultRequest,
} from "./client-agent-consult.types.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

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
  sessionTarget: PreparedTalkSessionTarget;
  voiceSessionId: string;
};

export type GatewayControlCommands = Parameters<
  NonNullable<RealtimeVoiceGatewayControl["bindControl"]>
>[0];
