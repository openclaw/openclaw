import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { TranscriptSenderIdentity } from "../../chat/sender-identity.js";
import type { PluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import type { RuntimePluginToolGrant } from "../../plugins/runtime/tool-grant.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { TrustedSessionCreation } from "../session-creation-provenance.js";

/** Trusted in-process spawn control plane that already owns this run's task row.
    Gateway CLI tracking only covers runs nobody else records, so a marked run
    must never get a second row. */
export type GatewayAgentRunTaskOwner = "plugin_subagent" | "native_subagent";

/** Caller identity captured by a built-in agent tool before trusted in-process dispatch. */
export type TrustedAgentToolCaller = Readonly<{
  agentId: string;
  sessionKey: string;
  /** Exact admitted requester lifetime; identity alone does not establish live authority. */
  assertCurrent?: () => void;
}>;

/** Closure-bound streaming hooks attached only to trusted plugin-owned synthetic clients. */
export type GatewayNodeInvokeStream = {
  onProgress: (chunk: string) => void;
  onDispatchReady: (invokeId: string) => void;
  idleTimeoutMs?: number;
  isRuntimeCurrent: () => boolean;
};

/** Handshake metadata retained for RPCs; transport retirement does not cancel admitted work. */
export type GatewayClient = Pick<
  GatewayWsClient,
  | "connect"
  | "authPolicy"
  | "invalidated"
  | "connectionSignal"
  | "browserOrigin"
  | "presenceKey"
  | "clientIp"
  | "pairedClientId"
  | "authenticatedUserId"
  | "authenticatedUserIsTailscaleProvider"
  | "authenticatedGitHubIdentitySync"
  | "preparedSessionProfile"
  | "pluginSurfaceUrls"
  | "pluginNodeCapabilitySurfaces"
  | "pluginNodeCapabilities"
  | "isDeviceTokenAuth"
  | "sharedGatewaySessionGeneration"
> & {
  usesSharedGatewayAuth?: boolean;
  connId?: string;
  authenticatedUserProfile?: Omit<
    NonNullable<GatewayWsClient["authenticatedUserProfile"]>,
    "avatarRevision"
  > & {
    avatarRevision?: string;
  };
  internal?: NonNullable<GatewayWsClient["internal"]> & {
    /** Marks the server-constructed client used by trusted in-process dispatch. */
    syntheticClient?: true;
    /** Original source restriction carried only by trusted in-process run admission. */
    operatorRunAuthority?: AdmittedRunOperatorAuthority;
    /** Overrides persisted sender attribution without changing the authorizing client identity. */
    senderAttribution?: { id: string; name?: string; identity?: TranscriptSenderIdentity };
    /** Trusted session creation provenance; never accepted from Gateway wire params. */
    sessionCreation?: TrustedSessionCreation;
    /** Trusted built-in agent tool caller; never accepted from Gateway wire params. */
    agentToolCaller?: TrustedAgentToolCaller;
    allowModelOverride?: boolean;
    cronRunContinuation?: boolean;
    pluginRuntimeOwnerId?: string;
    /** Host-attested session provenance for a trusted official plugin node invocation. */
    nodeInvokeApprovalSessionKey?: string;
    /** Plugin-owned in-process invoke hooks; never accepted from Gateway wire params. */
    nodeInvokeStream?: GatewayNodeInvokeStream;
    agentRunTracking?: GatewayAgentRunTaskOwner;
    /** Host-captured requester lineage for opt-in plugin subagent completion delivery. */
    pluginSubagentRequester?: PluginSubagentRequesterContext;
    /** Host-owned exact media set for a scoped automatic recovery delivery. */
    internalDeliveryMediaUrls?: string[];
    runtimeContextFragments?: RuntimeContextFragment[];
    internalDeliverySuppressText?: boolean;
    /** Host-owned: deliver only authored output, never runtime error payloads. */
    internalDeliverySuppressErrors?: boolean;
    /** Plugin-owned tools authorized for this internal subagent run. */
    runtimePluginToolGrant?: RuntimePluginToolGrant;
    /** Host-owned exact tool cap for a tracked plugin subagent run. */
    pluginSubagentToolsAllow?: string[];
    /** Opaque in-process subagent-completion capability; never accepted from wire params. */
    delegatedToolPolicyHandoffId?: string;
  };
};
