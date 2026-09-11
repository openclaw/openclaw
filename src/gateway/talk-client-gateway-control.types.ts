import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceGatewayControl,
} from "../talk/provider-types.js";
import type {
  TalkAgentConsultLifecycleMethods,
  TalkAgentConsultRequest,
} from "./talk-client-agent-consult.types.js";
import type { PreparedTalkSessionTarget } from "./talk-session-target.types.js";

type GatewayTalkAgentConsultRunner = (
  request: TalkAgentConsultRequest,
) => ReturnType<RealtimeVoiceAgentConsultRunner>;

export type GatewayControlOwner = {
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
