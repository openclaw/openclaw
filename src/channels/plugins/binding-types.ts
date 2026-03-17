import type {
  ConfiguredAcpBindingChannel,
  ResolvedConfiguredAcpBinding,
} from "../../acp/persistent-bindings.types.js";
import type { AgentAcpBinding } from "../../config/types.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";

export type ConfiguredBindingConversation = ConversationRef;

export type StatefulBindingTargetDescriptor = {
  kind: "stateful";
  driverId: string;
  sessionKey: string;
  agentId: string;
  label?: string;
};

export type CompiledConfiguredBinding = {
  channel: ConfiguredAcpBindingChannel;
  accountPattern?: string;
  binding: AgentAcpBinding;
  bindingConversationId: string;
  target: ChannelConfiguredBindingConversationRef;
  agentId: string;
  acpAgentId?: string;
  mode: ResolvedConfiguredAcpBinding["spec"]["mode"];
  cwd?: string;
  backend?: string;
  label?: string;
  provider: ChannelConfiguredBindingProvider;
  statefulTarget: StatefulBindingTargetDescriptor;
};

export type ConfiguredBindingResolution = {
  conversation: ConfiguredBindingConversation;
  compiledBinding: CompiledConfiguredBinding;
  match: ChannelConfiguredBindingMatch;
  configuredBinding: ResolvedConfiguredAcpBinding;
  statefulTarget: StatefulBindingTargetDescriptor;
};

/** @deprecated Use ConfiguredBindingConversation. */
export type AcpBindingConversation = ConfiguredBindingConversation;
/** @deprecated Use CompiledConfiguredBinding. */
export type CompiledAcpBinding = CompiledConfiguredBinding;
/** @deprecated Use ConfiguredBindingResolution. */
export type AcpBindingResolution = ConfiguredBindingResolution;
