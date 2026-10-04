import type { AgentBinding } from "../../config/types.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";
import type { ChannelId } from "./types.public.js";

/**
 * Stateful target descriptor produced by a binding consumer.
 */
export type StatefulBindingTargetDescriptor = {
  kind: "stateful";
  driverId: string;
  sessionKey: string;
  agentId: string;
  label?: string;
};

/**
 * Materialized binding record plus the stateful target it points at.
 */
export type ConfiguredBindingRecordResolution = {
  record: SessionBindingRecord;
  statefulTarget: StatefulBindingTargetDescriptor;
};

/**
 * Compiled binding rule with provider matcher, target factory, and static target facts.
 */
export type CompiledConfiguredBinding = {
  channel: ChannelId;
  accountPattern?: string;
  binding: AgentBinding;
  bindingConversationId: string;
  target: ChannelConfiguredBindingConversationRef;
  agentId: string;
  provider: ChannelConfiguredBindingProvider;
  targetFactory: {
    driverId: string;
    materialize: (params: {
      accountId: string;
      conversation: ChannelConfiguredBindingConversationRef;
    }) => ConfiguredBindingRecordResolution;
  };
};

/**
 * Full configured binding resolution used to rewrite routes and prepare target sessions.
 */
export type ConfiguredBindingResolution = ConfiguredBindingRecordResolution & {
  conversation: ConversationRef;
  compiledBinding: CompiledConfiguredBinding;
  match: ChannelConfiguredBindingMatch;
};
