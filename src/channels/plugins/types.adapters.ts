import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import type { AgentBinding } from "../../config/types.agents.js";
import type { DmScope } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GroupToolPolicyConfig } from "../../config/types.tools.js";
import type {
  ChannelApprovalNativeRuntimeAdapter,
  ChannelApprovalNativeRuntimeAdapterAsync,
} from "../../infra/approval-handler-runtime-types.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "../../infra/exec-approvals-core.js";
import type {
  PluginApprovalRequest,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequest } from "../../infra/system-agent-approvals.js";
import type { PluginServiceSchedulerV1 } from "../../plugins/service-scheduler.types.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ResolverContext, SecretDefaults } from "../../secrets/runtime-shared.js";
import type { SecretTargetRegistryEntry } from "../../secrets/target-registry-types.js";
import type { SecurityAuditFinding } from "../../security/audit.types.js";
import type {
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeAdapterAsync,
} from "./approval-native.types.js";
import type { ChannelRuntimeSurface } from "./channel-runtime-surface.types.js";
import type { ConfigWriteTarget } from "./config-writes.js";
import type {
  ChannelAccountSnapshot,
  ChannelAccountState,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelHeartbeatDeps,
  ChannelLegacyStateMigrationPlan,
  ChannelLogSink,
  ChannelSecurityContext,
  ChannelSecurityDmPolicy,
  ChannelStatusIssue,
} from "./types.core.js";
export type { ChannelSetupAdapter } from "./setup-adapter.types.js";
export type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundPayloadContext,
  ChannelOutboundPayloadHint,
  ChannelOutboundTargetRef,
  ChannelDeliveryCapabilities,
} from "./outbound.types.js";
export type { ChannelPairingAdapter } from "./pairing.types.js";

type ChannelActionAvailabilityState =
  | { kind: "enabled" }
  | { kind: "disabled" }
  | { kind: "unsupported" };

type ChannelApprovalForwardTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
  source?: "session" | "target";
};

export type ChannelCapabilitiesDisplayLine = {
  text: string;
  tone?: "default" | "muted" | "success" | "warn" | "error";
};

export type ChannelCapabilitiesDiagnostics = {
  lines?: ChannelCapabilitiesDisplayLine[];
  details?: Record<string, unknown>;
};

export type ChannelAccountLinkState = "linked" | "not-linked" | "unknown";

export type ChannelConfigAdapter<ResolvedAccount> = {
  listAccountIds: (cfg: OpenClawConfig) => string[];
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  /** Operational account preparation; preferred over the synchronous compatibility hook. */
  resolveAccountAsync?: (
    cfg: OpenClawConfig,
    accountId?: string | null,
  ) => Promise<ResolvedAccount>;
  inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
  defaultAccountId?: (cfg: OpenClawConfig) => string;
  setAccountEnabled?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    enabled: boolean;
  }) => OpenClawConfig;
  deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
  isEnabled?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean;
  disabledReason?: (account: ResolvedAccount, cfg: OpenClawConfig) => string;
  isConfigured?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
  isLinked?: (
    account: ResolvedAccount,
    cfg: OpenClawConfig,
  ) => ChannelAccountLinkState | Promise<ChannelAccountLinkState>;
  unconfiguredReason?: (account: ResolvedAccount, cfg: OpenClawConfig) => string;
  unlinkedReason?: (account: ResolvedAccount, cfg: OpenClawConfig) => string;
  describeAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot;
  describeAccountAsync?: (
    account: ResolvedAccount,
    cfg: OpenClawConfig,
  ) => Promise<ChannelAccountSnapshot>;
  resolveAllowFrom?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Array<string | number> | undefined;
  resolveAllowFromAsync?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<Array<string | number> | undefined>;
  formatAllowFrom?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    allowFrom: Array<string | number>;
  }) => string[];
  hasConfiguredState?: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  hasConfiguredStateAsync?: (params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }) => Promise<boolean>;
  hasPersistedAuthState?: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  resolveDefaultTo?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string | undefined;
};

export type ChannelSecretsAdapter = {
  secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
  unsupportedSecretRefSurfacePatterns?: readonly string[];
  collectUnsupportedSecretRefConfigCandidates?: (raw: unknown) => Array<{
    path: string;
    value: unknown;
  }>;
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
};

export type ChannelGroupAdapter = {
  resolveRequireMention?: (params: ChannelGroupContext) => boolean | undefined;
  resolveToolPolicy?: (params: ChannelGroupContext) => GroupToolPolicyConfig | undefined;
};
export type ChannelStatusAdapter<ResolvedAccount, Probe = unknown, Audit = unknown> = {
  defaultRuntime?: ChannelAccountSnapshot;
  buildChannelSummary?: (params: {
    account: ResolvedAccount;
    cfg: OpenClawConfig;
    defaultAccountId: string;
    snapshot: ChannelAccountSnapshot;
  }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  probeAccount?: (params: {
    account: ResolvedAccount;
    timeoutMs: number;
    cfg: OpenClawConfig;
  }) => Promise<Probe>;
  formatCapabilitiesProbe?: (params: { probe: Probe }) => ChannelCapabilitiesDisplayLine[];
  auditAccount?: (params: {
    account: ResolvedAccount;
    timeoutMs: number;
    cfg: OpenClawConfig;
    probe?: Probe;
  }) => Promise<Audit>;
  buildCapabilitiesDiagnostics?: (params: {
    account: ResolvedAccount;
    timeoutMs: number;
    cfg: OpenClawConfig;
    probe?: Probe;
    audit?: Audit;
    target?: string;
  }) => Promise<ChannelCapabilitiesDiagnostics | undefined>;
  buildAccountSnapshot?: (params: {
    account: ResolvedAccount;
    cfg: OpenClawConfig;
    runtime?: ChannelAccountSnapshot;
    probe?: Probe;
    audit?: Audit;
  }) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>;
  logSelfId?: (params: {
    account: ResolvedAccount;
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    includeChannelPrefix?: boolean;
  }) => void;
  resolveAccountState?: (params: {
    account: ResolvedAccount;
    cfg: OpenClawConfig;
    configured: boolean;
    enabled: boolean;
  }) => ChannelAccountState;
  collectStatusIssues?: (accounts: ChannelAccountSnapshot[]) => ChannelStatusIssue[];
};

export type ChannelGatewayContext<ResolvedAccount = unknown> = {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  /** Account-owned timed work; required by the version 2 Gateway adapter. */
  scheduler?: PluginServiceSchedulerV1;
  log?: ChannelLogSink;
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
  /** Clear cached outbound directory lookups after the channel accepts newer directory data. */
  invalidateDirectoryCache?: () => void;
  /**
   * Host-provided channel helpers for dispatch, routing, sessions, text, media,
   * command authorization, groups, and pairing. Present when Gateway startup
   * has a runtime resolver; external plugins must handle its absence.
   * @since Plugin SDK 2026.2.19
   */
  channelRuntime?: ChannelRuntimeSurface;
};

export type ChannelGatewayContextV2<ResolvedAccount = unknown> =
  ChannelGatewayContext<ResolvedAccount> & { scheduler: PluginServiceSchedulerV1 };

export type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
  apiVersion?: 1;
  startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  /** Keep gateway auth bypass resolution mirrored through a lightweight top-level `gateway-auth-api.ts` artifact. */
  resolveGatewayAuthBypassPaths?: (params: { cfg: OpenClawConfig }) => string[];
  loginWithQrStart?: (params: {
    accountId?: string;
    force?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
  }) => Promise<{
    qrDataUrl?: string;
    message: string;
    connected?: boolean;
    sessionKey?: string;
  }>;
  loginWithQrWait?: (params: {
    accountId?: string;
    sessionKey?: string;
    timeoutMs?: number;
    currentQrDataUrl?: string;
  }) => Promise<{
    connected: boolean;
    message: string;
    qrDataUrl?: string;
  }>;
  logoutAccount?: (ctx: {
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    runtime: RuntimeEnv;
    log?: ChannelLogSink;
  }) => Promise<{
    cleared: boolean;
    loggedOut?: boolean;
    [key: string]: unknown;
  }>;
};

export type ChannelGatewayAdapterV2<ResolvedAccount = unknown> = Omit<
  ChannelGatewayAdapter<ResolvedAccount>,
  "apiVersion" | "startAccount" | "stopAccount"
> & {
  apiVersion: 2;
  startAccount?: (ctx: ChannelGatewayContextV2<ResolvedAccount>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContextV2<ResolvedAccount>) => Promise<void>;
};

export type ChannelAuthAdapter = {
  login?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    runtime: RuntimeEnv;
    verbose?: boolean;
    channelInput?: string | null;
  }) => Promise<void>;
};

export type ChannelHeartbeatAdapter = {
  checkReady?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    deps?: ChannelHeartbeatDeps;
  }) => Promise<{ ok: boolean; reason: string }>;
  sendTyping?: (params: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
    deps?: ChannelHeartbeatDeps;
  }) => Promise<void> | void;
  /** Optional owned typing: recheck the guard after transport waits and honor cancellation. */
  sendTypingGuarded?: (params: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
    signal: AbortSignal;
    assertPlatformSendAuthorized: () => void;
  }) => Promise<void> | void;
  clearTyping?: NonNullable<ChannelHeartbeatAdapter["sendTyping"]>;
};

type ChannelDirectoryListParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  runtime: RuntimeEnv;
};

export type ChannelDirectoryAdapter = {
  self?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    runtime: RuntimeEnv;
  }) => Promise<ChannelDirectoryEntry | null>;
  listPeers?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listPeersLive?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listGroups?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listGroupsLive?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listGroupMembers?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId: string;
    limit?: number | null;
    runtime: RuntimeEnv;
  }) => Promise<ChannelDirectoryEntry[]>;
};

export type ChannelResolveKind = "user" | "group";

export type ChannelResolveResult = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

export type ChannelResolverAdapter = {
  resolveTargets: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    inputs: string[];
    kind: ChannelResolveKind;
    runtime: RuntimeEnv;
  }) => Promise<ChannelResolveResult[]>;
};

export type ChannelElevatedAdapter = {
  allowFromFallback?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Array<string | number> | undefined;
};

export type ChannelCommandAdapter = {
  enforceOwnerForCommands?: boolean;
  skipWhenConfigEmpty?: boolean;
  nativeCommandsAutoEnabled?: boolean;
  nativeSkillsAutoEnabled?: boolean;
  preferSenderE164ForCommands?: boolean;
  resolveNativeCommandName?: (params: {
    commandKey: string;
    defaultName: string;
  }) => string | undefined;
  buildCommandsListChannelData?: (params: {
    currentPage: number;
    totalPages: number;
    agentId?: string;
  }) => ReplyPayload["channelData"] | null;
  buildModelsMenuChannelData?: (params: {
    providers: Array<{ id: string; count: number }>;
  }) => ReplyPayload["channelData"] | null;
  buildModelsProviderChannelData?: NonNullable<ChannelCommandAdapter["buildModelsMenuChannelData"]>;
  buildModelsAddProviderChannelData?: (params: {
    providers: Array<{ id: string }>;
  }) => ReplyPayload["channelData"] | null;
  buildModelsListChannelData?: (params: {
    provider: string;
    models: readonly string[];
    currentModel?: string;
    currentPage: number;
    totalPages: number;
    pageSize?: number;
    modelNames?: ReadonlyMap<string, string>;
  }) => ReplyPayload["channelData"] | null;
  buildModelBrowseChannelData?: () => ReplyPayload["channelData"] | null;
};

export type ChannelDoctorConfigMutation = {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
  /** null defers environment-dependent eligibility; an undefined account ID selects the root. */
  historicalWebhookAccountIds?: readonly (string | undefined)[] | null;
};

export type ChannelDoctorLegacyConfigRule = LegacyConfigRule;

export type ChannelDoctorSequenceResult = {
  changeNotes: string[];
  infoNotes?: string[];
  warningNotes: string[];
};

export type ChannelDoctorEmptyAllowlistAccountContext = {
  account: Record<string, unknown>;
  channelName: string;
  dmPolicy?: string;
  effectiveAllowFrom?: Array<string | number>;
  parent?: Record<string, unknown>;
  prefix: string;
};

export type ChannelDoctorAdapter = {
  dmAllowFromMode?: "topOnly" | "topOrNested" | "nestedOnly";
  groupModel?: "sender" | "route" | "hybrid";
  groupAllowFromFallbackToAllowFrom?: boolean;
  warnOnEmptyGroupSenderAllowlist?: boolean;
  legacyConfigRules?: LegacyConfigRule[];
  normalizeCompatibilityConfig?: (params: { cfg: OpenClawConfig }) => ChannelDoctorConfigMutation;
  collectPreviewWarnings?: (params: {
    cfg: OpenClawConfig;
    doctorFixCommand: string;
    env?: NodeJS.ProcessEnv;
  }) => string[] | Promise<string[]>;
  collectMutableAllowlistWarnings?: (params: {
    cfg: OpenClawConfig;
  }) => string[] | Promise<string[]>;
  repairConfig?: (params: {
    cfg: OpenClawConfig;
    doctorFixCommand: string;
    env?: NodeJS.ProcessEnv;
  }) => ChannelDoctorConfigMutation | Promise<ChannelDoctorConfigMutation>;
  runConfigSequence?: (params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    shouldRepair: boolean;
  }) => ChannelDoctorSequenceResult | Promise<ChannelDoctorSequenceResult>;
  cleanStaleConfig?: (params: {
    cfg: OpenClawConfig;
  }) => ChannelDoctorConfigMutation | Promise<ChannelDoctorConfigMutation>;
  collectEmptyAllowlistExtraWarnings?: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => string[];
  shouldSkipDefaultEmptyGroupAllowlistWarning?: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => boolean;
};

export type ChannelLifecycleAdapter = {
  onAccountConfigChanged?: (params: {
    prevCfg: OpenClawConfig;
    nextCfg: OpenClawConfig;
    accountId: string;
    runtime: RuntimeEnv;
  }) => Promise<void> | void;
  onAccountRemoved?: (params: {
    prevCfg: OpenClawConfig;
    accountId: string;
    runtime: RuntimeEnv;
  }) => Promise<void> | void;
  runStartupMaintenance?: (params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    log: {
      info?: (message: string) => void;
      warn?: (message: string) => void;
    };
    trigger?: string;
    logPrefix?: string;
  }) => Promise<void> | void;
  /**
   * @deprecated Export stateMigrations from the plugin doctor contract instead.
   * Removal plan: remove the lifecycle adapter after the 2027.1 external-plugin migration window.
   */
  detectLegacyStateMigrations?: (params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
  }) => ChannelLegacyStateMigrationPlan[] | Promise<ChannelLegacyStateMigrationPlan[]>;
};

type ChannelApprovalForwardingFallbackParams = {
  cfg: OpenClawConfig;
  approvalKind: ChannelApprovalKind;
  target: ChannelApprovalForwardTarget;
  request: ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
};

export type { ChannelApprovalNativeAdapter } from "./approval-native.types.js";

type ChannelApprovalRenderHandlers<Request, Resolved> = {
  buildPendingPayload?: (params: {
    cfg: OpenClawConfig;
    request: Request;
    target: ChannelApprovalForwardTarget;
    nowMs: number;
  }) => ReplyPayload | null;
  buildResolvedPayload?: (params: {
    cfg: OpenClawConfig;
    resolved: Resolved;
    target: ChannelApprovalForwardTarget;
  }) => ReplyPayload | null;
};

export type ChannelApprovalAdapter = {
  delivery?: {
    hasConfiguredDmRoute?: (params: { cfg: OpenClawConfig }) => boolean;
    hasConfiguredDmRouteAsync?: (params: { cfg: OpenClawConfig }) => Promise<boolean>;
    /** Deny a fallback that cannot satisfy this request's reviewer policy, even without a native handler. */
    shouldBlockForwardingFallback?: (params: ChannelApprovalForwardingFallbackParams) => boolean;
    shouldSuppressForwardingFallback?: (params: ChannelApprovalForwardingFallbackParams) => boolean;
    shouldSuppressForwardingFallbackAsync?: (
      params: ChannelApprovalForwardingFallbackParams,
    ) => Promise<boolean>;
  };
  nativeRuntime?: ChannelApprovalNativeRuntimeAdapter;
  nativeRuntimeAsync?: ChannelApprovalNativeRuntimeAdapterAsync;
  render?: {
    exec?: ChannelApprovalRenderHandlers<ExecApprovalRequest, ExecApprovalResolved>;
    plugin?: ChannelApprovalRenderHandlers<PluginApprovalRequest, PluginApprovalResolved>;
  };
  native?: ChannelApprovalNativeAdapter;
  nativeAsync?: ChannelApprovalNativeAdapterAsync;
  describeExecApprovalSetup?: (params: {
    channel: string;
    channelLabel: string;
    accountId?: string;
  }) => string | null | undefined;
  describePluginApprovalSetup?: NonNullable<ChannelApprovalAdapter["describeExecApprovalSetup"]>;
};

export type ChannelApprovalCapability = ChannelApprovalAdapter & {
  /** Confirms that this channel enforces configured plugin reviewer lists for routing and decisions. */
  supportsScopedPluginApprovalApprovers?: true;
  authorizeActorAction?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    senderId?: string | null;
    action: "approve";
    approvalKind: ChannelApprovalKind;
    request?: ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
  }) => {
    authorized: boolean;
    reason?: string;
  };
  resolveReviewerSenderId?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    senderId?: string | null;
    spaceId?: string | null;
  }) => string | undefined;
  getActionAvailabilityState?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    action: "approve";
    approvalKind?: ChannelApprovalKind;
    /** Exact pending plugin request when route availability depends on its selected tool. */
    request?: PluginApprovalRequest;
  }) => ChannelActionAvailabilityState;
  /** Exec-native client availability for the initiating surface; distinct from same-chat auth. */
  getExecInitiatingSurfaceState?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    action: "approve";
  }) => ChannelActionAvailabilityState;
  /** Await worker-owned state before deciding initiating-surface availability. */
  getExecInitiatingSurfaceStateAsync?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    action: "approve";
  }) => Promise<ChannelActionAvailabilityState>;
  resolveApproveCommandBehavior?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    senderId?: string | null;
    approvalKind: ChannelApprovalKind;
  }) => { kind: "allow" } | { kind: "ignore" } | { kind: "reply"; text: string } | undefined;
};

type ChannelAllowlistConfigEditResult =
  | { kind: "ok"; changed: boolean; pathLabel: string; writeTarget: ConfigWriteTarget }
  | { kind: "invalid-entry" };

type ChannelAllowlistConfig = {
  dmAllowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: string;
  groupPolicy?: string;
  groupOverrides?: Array<{ label: string; entries: Array<string | number> }>;
};

export type ChannelAllowlistAdapter = {
  applyConfigEdit?: (params: {
    cfg: OpenClawConfig;
    parsedConfig: Record<string, unknown>;
    accountId?: string | null;
    scope: "dm" | "group";
    action: "add" | "remove";
    entry: string;
  }) => ChannelAllowlistConfigEditResult | Promise<ChannelAllowlistConfigEditResult> | null;
  readConfig?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => ChannelAllowlistConfig | Promise<ChannelAllowlistConfig>;
  resolveNames?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    scope: "dm" | "group";
    entries: string[];
  }) =>
    | Array<{ input: string; resolved: boolean; name?: string | null }>
    | Promise<Array<{ input: string; resolved: boolean; name?: string | null }>>;
  supportsScope?: (params: { scope: "dm" | "group" | "all" }) => boolean;
};

export type ChannelConfiguredBindingConversationRef = {
  conversationId: string;
  parentConversationId?: string;
};

export type ChannelConfiguredBindingMatch = ChannelConfiguredBindingConversationRef & {
  matchPriority?: number;
};

export type ChannelCommandConversationContext = {
  accountId: string;
  threadId?: string;
  threadParentId?: string;
  senderId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
  from?: string;
  chatType?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
};

export type ChannelConfiguredBindingProvider = {
  selfParentConversationByDefault?: boolean;
  compileConfiguredBinding: (params: {
    binding: AgentBinding;
    conversationId: string;
  }) => ChannelConfiguredBindingConversationRef | null;
  matchInboundConversation: (params: {
    binding: AgentBinding;
    compiledBinding: ChannelConfiguredBindingConversationRef;
    conversationId: string;
    parentConversationId?: string;
  }) => ChannelConfiguredBindingMatch | null;
  resolveCommandConversation?: (
    params: ChannelCommandConversationContext,
  ) => ChannelConfiguredBindingConversationRef | null;
};

export type { ChannelConversationBindingSupport } from "./types.conversation-bindings.js";

type ChannelSecurityDmRouteContext<ResolvedAccount> = ChannelSecurityContext<ResolvedAccount> & {
  accountId: string;
  principalId?: string;
};

export type ChannelSecurityAdapter<ResolvedAccount = unknown> = {
  applyConfigFixes?: (params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
  }) => ChannelDoctorConfigMutation | Promise<ChannelDoctorConfigMutation>;
  resolveDmPolicy?: (
    ctx: ChannelSecurityContext<ResolvedAccount>,
  ) => ChannelSecurityDmPolicy | null;
  resolveDmPolicyAsync?: (
    ctx: ChannelSecurityContext<ResolvedAccount>,
  ) => Promise<ChannelSecurityDmPolicy | null>;
  dmRouting?: {
    resolveDmScope?: (ctx: ChannelSecurityDmRouteContext<ResolvedAccount>) => DmScope | undefined;
    resolveDmRoute?: (
      ctx: ChannelSecurityDmRouteContext<ResolvedAccount> & { route: ResolvedAgentRoute },
    ) => { kind: "core" | "isolated" } | { sessionKey: string } | undefined;
  };
  collectWarnings?: (
    ctx: ChannelSecurityContext<ResolvedAccount>,
  ) => Promise<Array<string | SecurityAuditFinding>> | Array<string | SecurityAuditFinding>;
  collectAuditFindings?: (
    ctx: ChannelSecurityContext<ResolvedAccount> & {
      sourceConfig: OpenClawConfig;
      orderedAccountIds: string[];
      hasExplicitAccountPath: boolean;
    },
  ) => Promise<SecurityAuditFinding[]> | SecurityAuditFinding[];
};
