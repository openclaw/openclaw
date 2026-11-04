import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OperatorScope } from "../../gateway/operator-scopes.js";
import type { ChannelMessageAdapterShape } from "../message/types.js";
import type { ChannelSetupPlugin } from "./setup-wizard-types.js";
import type {
  ChannelApprovalCapability,
  ChannelAuthAdapter,
  ChannelCommandAdapter,
  ChannelConfigAdapter,
  ChannelConversationBindingSupport,
  ChannelDoctorAdapter,
  ChannelDirectoryAdapter,
  ChannelResolverAdapter,
  ChannelElevatedAdapter,
  ChannelGatewayAdapter,
  ChannelGatewayAdapterV2,
  ChannelGroupAdapter,
  ChannelHeartbeatAdapter,
  ChannelLifecycleAdapter,
  ChannelOutboundAdapter,
  ChannelPairingAdapter,
  ChannelSecretsAdapter,
  ChannelSecurityAdapter,
  ChannelStatusAdapter,
  ChannelAllowlistAdapter,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";
import type { ChannelConfigSchema } from "./types.config.js";
import type {
  ChannelAgentTool,
  ChannelAgentToolFactory,
  ChannelAgentPromptAdapter,
  ChannelMentionAdapter,
  ChannelMessageActionAdapter,
  ChannelMessagingAdapter,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
} from "./types.core.js";

type ChannelGatewayMethodDescriptor = {
  name: string;
  scope?: OperatorScope;
  description?: string;
};

/** Provider-owned proof of account control. Tokens never leave the provider adapter. */
type ChannelIdentityLinkAdapter = {
  prepare: (
    cfg: OpenClawConfig,
    accountId: string,
  ) => Promise<
    | {
        isCurrent: (cfg: OpenClawConfig) => boolean;
        authorizationUrl: (params: { state: string; redirectUri: string }) => string;
        exchange: (params: {
          code: string;
          redirectUri: string;
          signal: AbortSignal;
          assertCurrent: () => void;
        }) => Promise<{ senderId: string }>;
      }
    | undefined
  >;
};

/** Full capability contract for a native channel plugin. */
// Omitted generic means "plugin with some account shape"; using unknown makes
// callback parameters contravariant and rejects concrete plugin implementations.
export type ChannelPlugin<
  // oxlint-disable-next-line typescript/no-explicit-any
  ResolvedAccount = any,
  Probe = unknown,
  Audit = unknown,
  GatewayVersion extends 1 | 2 = 1,
> = Omit<ChannelSetupPlugin, "config"> & {
  defaults?: {
    queue?: {
      debounceMs?: number;
    };
  };
  reload?: {
    configPrefixes: string[];
    /** Published dynamic reads; `*` matches one nonempty dotted config key. */
    noopPrefixes?: string[];
    /**
     * Opt into restarting only the changed non-default named account.
     * Set only when sibling account resolution and lifecycle state are isolated and
     * account stop fully settles owned work. Shared, default, removed, or unresolved
     * account changes still restart the whole channel.
     */
    accountScopedRestart?: boolean;
  };
  config: ChannelConfigAdapter<ResolvedAccount>;
  configSchema?: ChannelConfigSchema;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  gatewayMethods?: string[];
  gatewayMethodDescriptors?: ChannelGatewayMethodDescriptor[];
  gateway?: GatewayVersion extends 2
    ? ChannelGatewayAdapterV2<ResolvedAccount>
    : ChannelGatewayAdapter<ResolvedAccount>;
  // Login/logout and channel-auth only. Approval auth lives on approvalCapability.
  auth?: ChannelAuthAdapter;
  identityLink?: ChannelIdentityLinkAdapter;
  approvalCapability?: ChannelApprovalCapability;
  elevated?: ChannelElevatedAdapter;
  commands?: ChannelCommandAdapter;
  lifecycle?: ChannelLifecycleAdapter;
  secrets?: ChannelSecretsAdapter;
  allowlist?: ChannelAllowlistAdapter;
  doctor?: ChannelDoctorAdapter;
  bindings?: ChannelConfiguredBindingProvider;
  conversationBindings?: ChannelConversationBindingSupport;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelMessagingAdapter;
  agentPrompt?: ChannelAgentPromptAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  // Channel-owned agent tools (login flows, etc.).
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};

/** Heterogeneous registries erase each plugin's account/probe/audit family, retaining its adapter version. */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyChannelPlugin = ChannelPlugin<any, any, any, 1 | 2>;
