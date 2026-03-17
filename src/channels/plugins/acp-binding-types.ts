import type {
  ConfiguredAcpBindingChannel,
  ConfiguredAcpBindingSpec,
  ResolvedConfiguredAcpBinding,
} from "../../acp/persistent-bindings.types.js";
import type { AgentAcpBinding } from "../../config/types.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type {
  ChannelAcpBindingAdapter,
  ChannelAcpBindingConversationRef,
  ChannelAcpBindingMatch,
} from "./types.adapters.js";

export type AcpBindingConversation = ConversationRef;

export type CompiledAcpBinding = {
  channel: ConfiguredAcpBindingChannel;
  accountPattern?: string;
  binding: AgentAcpBinding;
  bindingConversationId: string;
  target: ChannelAcpBindingConversationRef;
  agentId: string;
  acpAgentId?: string;
  mode: ConfiguredAcpBindingSpec["mode"];
  cwd?: string;
  backend?: string;
  label?: string;
  adapter: ChannelAcpBindingAdapter;
};

export type AcpBindingResolution = {
  conversation: AcpBindingConversation;
  compiledBinding: CompiledAcpBinding;
  match: ChannelAcpBindingMatch;
  configuredBinding: ResolvedConfiguredAcpBinding;
};
