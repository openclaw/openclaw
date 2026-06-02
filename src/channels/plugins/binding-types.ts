import type { AgentBinding } from "../../config/types.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ChannelConfiguredBindingConversationRef } from "./types.adapters.js";
import type {
  ChannelConfiguredBindingMatch,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";
import type { ChannelId } from "./types.public.js";

/** Runtime conversation identity used by configured binding lookup. */
export type ConfiguredBindingConversation = ConversationRef;
/** Channel id type used after configured binding channel normalization. */
export type ConfiguredBindingChannel = ChannelId;
/** Raw binding config rule before channel-specific compilation. */
export type ConfiguredBindingRuleConfig = AgentBinding;

/** Stateful target descriptor emitted by a configured binding target factory. */
export type StatefulBindingTargetDescriptor = {
  kind: "stateful";
  driverId: string;
  sessionKey: string;
  agentId: string;
  label?: string;
};

/** Persisted binding record plus the stateful target it materializes. */
export type ConfiguredBindingRecordResolution = {
  record: SessionBindingRecord;
  statefulTarget: StatefulBindingTargetDescriptor;
};

/** Channel/consumer-owned factory that materializes configured binding targets. */
export type ConfiguredBindingTargetFactory = {
  driverId: string;
  materialize: (params: {
    accountId: string;
    conversation: ChannelConfiguredBindingConversationRef;
  }) => ConfiguredBindingRecordResolution;
};

/** Channel-compiled binding rule ready for conversation matching. */
export type CompiledConfiguredBinding = {
  channel: ConfiguredBindingChannel;
  accountPattern?: string;
  binding: ConfiguredBindingRuleConfig;
  bindingConversationId: string;
  target: ChannelConfiguredBindingConversationRef;
  agentId: string;
  provider: ChannelConfiguredBindingProvider;
  targetFactory: ConfiguredBindingTargetFactory;
};

/** Full configured binding resolution used by routing and target drivers. */
export type ConfiguredBindingResolution = ConfiguredBindingRecordResolution & {
  conversation: ConfiguredBindingConversation;
  compiledBinding: CompiledConfiguredBinding;
  match: ChannelConfiguredBindingMatch;
};
