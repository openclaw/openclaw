import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import type { AgentBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GroupToolPolicyConfig } from "../../config/types.tools.js";
import type { ChannelApprovalNativeRuntimeAdapter } from "../../infra/approval-handler-runtime-types.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "../../infra/exec-approvals.js";
import type {
  PluginApprovalRequest,
  PluginApprovalResolved,
} from "../../infra/plugin-approvals.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ResolverContext, SecretDefaults } from "../../secrets/runtime-shared.js";
import type { SecretTargetRegistryEntry } from "../../secrets/target-registry-types.js";
import type { ChannelApprovalNativeAdapter } from "./approval-native.types.js";
import type { ChannelRuntimeSurface } from "./channel-runtime-surface.types.js";
import type { ConfigWriteTarget } from "./config-writes.js";
export type {
  ChannelOutboundAdapter,
  ChannelOutboundChunkContext,
  ChannelOutboundContext,
  ChannelOutboundFormattedContext,
  ChannelOutboundPayloadContext,
  ChannelOutboundPayloadHint,
  ChannelOutboundTargetRef,
  ChannelDeliveryCapabilities,
} from "./outbound.types.js";
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
  ChannelSetupInput,
  ChannelStatusIssue,
} from "./types.core.js";
export type { ChannelPairingAdapter } from "./pairing.types.js";

type ConfiguredBindingRule = AgentBinding;
export type { ChannelApprovalKind } from "../../infra/approval-types.js";

/** Availability state for a plugin action after config and platform support are checked. */
export type ChannelActionAvailabilityState =
  | { kind: "enabled" }
  | { kind: "disabled" }
  | { kind: "unsupported" };

export type ChannelApprovalInitiatingSurfaceState = ChannelActionAvailabilityState;

/** Destination chosen for forwarding an approval request into a channel. */
export type ChannelApprovalForwardTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
  source?: "session" | "target";
};

/** Tone token rendered by status/capability diagnostics. */
export type ChannelCapabilitiesDisplayTone = "default" | "muted" | "success" | "warn" | "error";

/** Single human-readable status line produced by channel diagnostics. */
export type ChannelCapabilitiesDisplayLine = {
  text: string;
  tone?: ChannelCapabilitiesDisplayTone;
};

/** Structured diagnostics used by status output and troubleshooting views. */
export type ChannelCapabilitiesDiagnostics = {
  lines?: ChannelCapabilitiesDisplayLine[];
  details?: Record<string, unknown>;
};

type ChannelAdapterCallback<T extends (...args: never[]) => unknown> = T;

/** Setup-time config mutation hooks shared by CLI, onboarding, and plugin setup wizards. */
export type ChannelSetupAdapter = {
  resolveAccountId?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    input?: ChannelSetupInput;
  }) => string;
  resolveBindingAccountId?: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    accountId?: string;
  }) => string | undefined;
  applyAccountName?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    name?: string;
  }) => OpenClawConfig;
  applyAccountConfig: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => OpenClawConfig;
  afterAccountConfigWritten?: (params: {
    previousCfg: OpenClawConfig;
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
    runtime: RuntimeEnv;
  }) => Promise<void> | void;
  validateInput?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => string | null;
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: Record<string, unknown>;
  }) => string | undefined;
};

/** Required account/config access contract for every channel plugin. */
export type ChannelConfigAdapter<ResolvedAccount> = {
  listAccountIds: (cfg: OpenClawConfig) => string[];
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
  defaultAccountId?: (cfg: OpenClawConfig) => string;
  setAccountEnabled?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    enabled: boolean;
  }) => OpenClawConfig;
  deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
  isEnabled?: ChannelAdapterCallback<(account: ResolvedAccount, cfg: OpenClawConfig) => boolean>;
  disabledReason?: ChannelAdapterCallback<
    (account: ResolvedAccount, cfg: OpenClawConfig) => string
  >;
  isConfigured?: ChannelAdapterCallback<
    (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>
  >;
  unconfiguredReason?: ChannelAdapterCallback<
    (account: ResolvedAccount, cfg: OpenClawConfig) => string
  >;
  describeAccount?: ChannelAdapterCallback<
    (account: ResolvedAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot
  >;
  resolveAllowFrom?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Array<string | number> | undefined;
  formatAllowFrom?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    allowFrom: Array<string | number>;
  }) => string[];
  hasConfiguredState?: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  hasPersistedAuthState?: (params: { cfg: OpenClawConfig; env?: NodeJS.ProcessEnv }) => boolean;
  resolveDefaultTo?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => string | undefined;
};

/** Secret-reference and runtime-secret integration points owned by a plugin. */
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

/** Group policy hooks used by inbound routing and command authorization. */
export type ChannelGroupAdapter = {
  resolveRequireMention?: (params: ChannelGroupContext) => boolean | undefined;
  resolveGroupIntroHint?: (params: ChannelGroupContext) => string | undefined;
  resolveToolPolicy?: (params: ChannelGroupContext) => GroupToolPolicyConfig | undefined;
};

/** Status, probe, and diagnostics hooks for one configured account. */
export type ChannelStatusAdapter<ResolvedAccount, Probe = unknown, Audit = unknown> = {
  defaultRuntime?: ChannelAccountSnapshot;
  buildChannelSummary?: ChannelAdapterCallback<
    (params: {
      account: ResolvedAccount;
      cfg: OpenClawConfig;
      defaultAccountId: string;
      snapshot: ChannelAccountSnapshot;
    }) => Record<string, unknown> | Promise<Record<string, unknown>>
  >;
  probeAccount?: ChannelAdapterCallback<
    (params: { account: ResolvedAccount; timeoutMs: number; cfg: OpenClawConfig }) => Promise<Probe>
  >;
  formatCapabilitiesProbe?: ChannelAdapterCallback<
    (params: { probe: Probe }) => ChannelCapabilitiesDisplayLine[]
  >;
  auditAccount?: ChannelAdapterCallback<
    (params: {
      account: ResolvedAccount;
      timeoutMs: number;
      cfg: OpenClawConfig;
      probe?: Probe;
    }) => Promise<Audit>
  >;
  buildCapabilitiesDiagnostics?: ChannelAdapterCallback<
    (params: {
      account: ResolvedAccount;
      timeoutMs: number;
      cfg: OpenClawConfig;
      probe?: Probe;
      audit?: Audit;
      target?: string;
    }) => Promise<ChannelCapabilitiesDiagnostics | undefined>
  >;
  buildAccountSnapshot?: ChannelAdapterCallback<
    (params: {
      account: ResolvedAccount;
      cfg: OpenClawConfig;
      runtime?: ChannelAccountSnapshot;
      probe?: Probe;
      audit?: Audit;
    }) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>
  >;
  logSelfId?: ChannelAdapterCallback<
    (params: {
      account: ResolvedAccount;
      cfg: OpenClawConfig;
      runtime: RuntimeEnv;
      includeChannelPrefix?: boolean;
    }) => void
  >;
  resolveAccountState?: ChannelAdapterCallback<
    (params: {
      account: ResolvedAccount;
      cfg: OpenClawConfig;
      configured: boolean;
      enabled: boolean;
    }) => ChannelAccountState
  >;
  collectStatusIssues?: (accounts: ChannelAccountSnapshot[]) => ChannelStatusIssue[];
};

/** Runtime context passed to a channel account when the gateway starts it. */
export type ChannelGatewayContext<ResolvedAccount = unknown> = {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
  /**
   * Optional channel runtime helpers for external channel plugins.
   *
   * This field provides the canonical channel runtime helpers for channel
   * dispatch, routing, session, reply, and startup context work.
   *
   * ## Available Features
   *
   * - **reply**: AI response dispatching, formatting, and delivery
   * - **routing**: Agent route resolution and matching
   * - **text**: Text chunking, markdown processing, and control command detection
   * - **session**: Session management and metadata tracking
   * - **media**: Remote media fetching and buffer saving
   * - **commands**: Command authorization and control command handling
   * - **groups**: Group policy resolution and mention requirements
   * - **pairing**: Channel pairing and allow-from management
   *
   * ## Use Cases
   *
   * Channel plugins that need:
   * - AI-powered response generation and delivery
   * - Advanced text processing and formatting
   * - Session tracking and management
   * - Agent routing and policy resolution
   *
   * ## Example
   *
   * ```typescript
   * const emailGatewayAdapter: ChannelGatewayAdapter<EmailAccount> = {
   *   startAccount: async (ctx) => {
   *     // Check availability (for backward compatibility)
   *     if (!ctx.channelRuntime) {
   *       ctx.log?.warn?.("channelRuntime not available - skipping AI features");
   *       return;
   *     }
   *
   *     // Use AI dispatch
   *     await ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
   *       ctx: { ... },
   *       cfg: ctx.cfg,
   *       dispatcherOptions: {
   *         deliver: async (payload) => {
   *           // Send reply via email
   *         },
   *       },
   *     });
   *   },
   * };
   * ```
   *
   * ## Backward Compatibility
   *
   * - This field is **optional** - channels that don't need it can ignore it
   * - Gateway startup passes a full `createPluginRuntime().channel` surface
   *   when a runtime resolver is configured
   * - External plugins should check for undefined before using
   *
   * @since Plugin SDK 2026.2.19
   * @see {@link https://docs.openclaw.ai/plugins/building-plugins | Plugin SDK documentation}
   */
  channelRuntime?: ChannelRuntimeSurface;
};

/** Logout result returned by channel auth/runtime adapters. */
export type ChannelLogoutResult = {
  cleared: boolean;
  loggedOut?: boolean;
  [key: string]: unknown;
};

/** First response for QR-style login flows, often before the account is connected. */
export type ChannelLoginWithQrStartResult = {
  qrDataUrl?: string;
  message: string;
  connected?: boolean;
};

/** Poll/wait response for QR-style login flows after the user scans or times out. */
export type ChannelLoginWithQrWaitResult = {
  connected: boolean;
  message: string;
  qrDataUrl?: string;
};

/** Context for account logout without a live gateway start context. */
export type ChannelLogoutContext<ResolvedAccount = unknown> = {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  log?: ChannelLogSink;
};

/** Gateway lifecycle and login adapter for channel account runtimes. */
export type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  /** Keep gateway auth bypass resolution mirrored through a lightweight top-level `gateway-auth-api.ts` artifact. */
  resolveGatewayAuthBypassPaths?: (params: { cfg: OpenClawConfig }) => string[];
  loginWithQrStart?: (params: {
    accountId?: string;
    force?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
  }) => Promise<ChannelLoginWithQrStartResult>;
  loginWithQrWait?: (params: {
    accountId?: string;
    timeoutMs?: number;
    currentQrDataUrl?: string;
  }) => Promise<ChannelLoginWithQrWaitResult>;
  logoutAccount?: (ctx: ChannelLogoutContext<ResolvedAccount>) => Promise<ChannelLogoutResult>;
};

/** Interactive login hook for channels that authenticate outside gateway startup. */
export type ChannelAuthAdapter = {
  login?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    runtime: RuntimeEnv;
    verbose?: boolean;
    channelInput?: string | null;
  }) => Promise<void>;
};

/** Lightweight readiness and typing hooks used by heartbeat/status replies. */
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
  clearTyping?: (params: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
    deps?: ChannelHeartbeatDeps;
  }) => Promise<void> | void;
};

type ChannelDirectorySelfParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  runtime: RuntimeEnv;
};

type ChannelDirectoryListParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  runtime: RuntimeEnv;
};

type ChannelDirectoryListGroupMembersParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId: string;
  limit?: number | null;
  runtime: RuntimeEnv;
};

/** Directory lookup hooks for peers, groups, and group members. */
export type ChannelDirectoryAdapter = {
  self?: (params: ChannelDirectorySelfParams) => Promise<ChannelDirectoryEntry | null>;
  listPeers?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listPeersLive?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listGroups?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listGroupsLive?: (params: ChannelDirectoryListParams) => Promise<ChannelDirectoryEntry[]>;
  listGroupMembers?: (
    params: ChannelDirectoryListGroupMembersParams,
  ) => Promise<ChannelDirectoryEntry[]>;
};

/** Target resolver class used by CLI/setup account allowlist flows. */
export type ChannelResolveKind = "user" | "group";

/** Result row for resolving a user-entered target into a provider id. */
export type ChannelResolveResult = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
};

/** Bulk resolver used when setup/config commands normalize allowlist targets. */
export type ChannelResolverAdapter = {
  resolveTargets: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    inputs: string[];
    kind: ChannelResolveKind;
    runtime: RuntimeEnv;
  }) => Promise<ChannelResolveResult[]>;
};

/** Elevated policy hooks for trusted channels or owner-only command contexts. */
export type ChannelElevatedAdapter = {
  allowFromFallback?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Array<string | number> | undefined;
};

/** Native command/menu rendering hooks for channel-specific control surfaces. */
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
  buildModelsProviderChannelData?: (params: {
    providers: Array<{ id: string; count: number }>;
  }) => ReplyPayload["channelData"] | null;
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

/** Config mutation result from channel doctor or compatibility repair hooks. */
export type ChannelDoctorConfigMutation = {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
};

export type ChannelDoctorLegacyConfigRule = LegacyConfigRule;

/** Result from an ordered doctor sequence that may include repair and warnings. */
export type ChannelDoctorSequenceResult = {
  changeNotes: string[];
  warningNotes: string[];
};

/** Context for default empty-allowlist warning decisions. */
export type ChannelDoctorEmptyAllowlistAccountContext = {
  account: Record<string, unknown>;
  channelName: string;
  dmPolicy?: string;
  effectiveAllowFrom?: Array<string | number>;
  parent?: Record<string, unknown>;
  prefix: string;
};

/** Doctor hooks for channel-owned config repair, warnings, and state migrations. */
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

/** Lifecycle hooks called after config writes, account removal, or gateway startup. */
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
  detectLegacyStateMigrations?: (params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
  }) => ChannelLegacyStateMigrationPlan[] | Promise<ChannelLegacyStateMigrationPlan[]>;
};

/** Channel-specific delivery controls for approval forwarding. */
export type ChannelApprovalDeliveryAdapter = {
  hasConfiguredDmRoute?: (params: { cfg: OpenClawConfig }) => boolean;
  shouldSuppressForwardingFallback?: (params: {
    cfg: OpenClawConfig;
    approvalKind: ChannelApprovalKind;
    target: ChannelApprovalForwardTarget;
    request: ExecApprovalRequest | PluginApprovalRequest;
  }) => boolean;
};

/** Behavior for native `/approve` commands after channel authorization checks. */
export type ChannelApproveCommandBehavior =
  | { kind: "allow" }
  | { kind: "ignore" }
  | { kind: "reply"; text: string };

export type {
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeDeliveryCapabilities,
  ChannelApprovalNativeDeliveryPreference,
  ChannelApprovalNativeRequest,
  ChannelApprovalNativeSurface,
  ChannelApprovalNativeTarget,
} from "./approval-native.types.js";

/** Channel renderer for pending/resolved approval messages. */
export type ChannelApprovalRenderAdapter = {
  exec?: {
    buildPendingPayload?: (params: {
      cfg: OpenClawConfig;
      request: ExecApprovalRequest;
      target: ChannelApprovalForwardTarget;
      nowMs: number;
    }) => ReplyPayload | null;
    buildResolvedPayload?: (params: {
      cfg: OpenClawConfig;
      resolved: ExecApprovalResolved;
      target: ChannelApprovalForwardTarget;
    }) => ReplyPayload | null;
  };
  plugin?: {
    buildPendingPayload?: (params: {
      cfg: OpenClawConfig;
      request: PluginApprovalRequest;
      target: ChannelApprovalForwardTarget;
      nowMs: number;
    }) => ReplyPayload | null;
    buildResolvedPayload?: (params: {
      cfg: OpenClawConfig;
      resolved: PluginApprovalResolved;
      target: ChannelApprovalForwardTarget;
    }) => ReplyPayload | null;
  };
};

/** Shared approval extension surface for exec and plugin approvals. */
export type ChannelApprovalAdapter = {
  delivery?: ChannelApprovalDeliveryAdapter;
  nativeRuntime?: ChannelApprovalNativeRuntimeAdapter;
  render?: ChannelApprovalRenderAdapter;
  native?: ChannelApprovalNativeAdapter;
  describeExecApprovalSetup?: (params: {
    channel: string;
    channelLabel: string;
    accountId?: string;
  }) => string | null | undefined;
};

/** Approval capability plus same-chat actor authorization hooks. */
export type ChannelApprovalCapability = ChannelApprovalAdapter & {
  authorizeActorAction?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    senderId?: string | null;
    action: "approve";
    approvalKind: "exec" | "plugin";
  }) => {
    authorized: boolean;
    reason?: string;
  };
  getActionAvailabilityState?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    action: "approve";
    approvalKind?: ChannelApprovalKind;
  }) => ChannelActionAvailabilityState;
  /** Exec-native client availability for the initiating surface; distinct from same-chat auth. */
  getExecInitiatingSurfaceState?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    action: "approve";
  }) => ChannelActionAvailabilityState;
  resolveApproveCommandBehavior?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    senderId?: string | null;
    approvalKind: ChannelApprovalKind;
  }) => ChannelApproveCommandBehavior | undefined;
};

/** Config read/write hooks for channel allowlist commands. */
export type ChannelAllowlistAdapter = {
  applyConfigEdit?: (params: {
    cfg: OpenClawConfig;
    parsedConfig: Record<string, unknown>;
    accountId?: string | null;
    scope: "dm" | "group";
    action: "add" | "remove";
    entry: string;
  }) =>
    | {
        kind: "ok";
        changed: boolean;
        pathLabel: string;
        writeTarget: ConfigWriteTarget;
      }
    | {
        kind: "invalid-entry";
      }
    | Promise<
        | {
            kind: "ok";
            changed: boolean;
            pathLabel: string;
            writeTarget: ConfigWriteTarget;
          }
        | {
            kind: "invalid-entry";
          }
      >
    | null;
  readConfig?: (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    | {
        dmAllowFrom?: Array<string | number>;
        groupAllowFrom?: Array<string | number>;
        dmPolicy?: string;
        groupPolicy?: string;
        groupOverrides?: Array<{ label: string; entries: Array<string | number> }>;
      }
    | Promise<{
        dmAllowFrom?: Array<string | number>;
        groupAllowFrom?: Array<string | number>;
        dmPolicy?: string;
        groupPolicy?: string;
        groupOverrides?: Array<{ label: string; entries: Array<string | number> }>;
      }>;
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

/** Canonical provider conversation id plus optional parent id. */
export type ChannelConfiguredBindingConversationRef = {
  conversationId: string;
  parentConversationId?: string;
};

/** Binding match result; higher priority wins when multiple bindings match. */
export type ChannelConfiguredBindingMatch = ChannelConfiguredBindingConversationRef & {
  matchPriority?: number;
};

/** Command-origin details used to resolve the conversation an agent should bind to. */
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

/** Provider-specific matching for configured conversation bindings. */
export type ChannelConfiguredBindingProvider = {
  selfParentConversationByDefault?: boolean;
  compileConfiguredBinding: (params: {
    binding: ConfiguredBindingRule;
    conversationId: string;
  }) => ChannelConfiguredBindingConversationRef | null;
  matchInboundConversation: (params: {
    binding: ConfiguredBindingRule;
    compiledBinding: ChannelConfiguredBindingConversationRef;
    conversationId: string;
    parentConversationId?: string;
  }) => ChannelConfiguredBindingMatch | null;
  resolveCommandConversation?: (
    params: ChannelCommandConversationContext,
  ) => ChannelConfiguredBindingConversationRef | null;
};

/** Runtime support for creating and managing conversation-bound agents. */
export type ChannelConversationBindingSupport = {
  supportsCurrentConversationBinding?: boolean;
  /**
   * Preferred placement when a command is started from a top-level conversation
   * without an existing native thread id.
   *
   * - `current`: bind/spawn in the current conversation
   * - `child`: create a child thread/conversation first
   */
  defaultTopLevelPlacement?: "current" | "child";
  resolveConversationRef?: (params: {
    accountId?: string | null;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number | null;
  }) => {
    conversationId: string;
    parentConversationId?: string;
  } | null;
  buildBoundReplyPayload?: (params: {
    operation: "acp-spawn";
    placement: "current" | "child";
    conversation: {
      channel: string;
      accountId?: string | null;
      conversationId: string;
      parentConversationId?: string;
    };
  }) =>
    | Pick<ReplyPayload, "channelData" | "delivery" | "presentation">
    | null
    | Promise<Pick<ReplyPayload, "channelData" | "delivery" | "presentation"> | null>;
  buildModelOverrideParentCandidates?: (params: {
    parentConversationId?: string | null;
  }) => string[] | null | undefined;
  shouldStripThreadFromAnnounceOrigin?: (params: {
    requester: {
      channel?: string;
      to?: string;
      threadId?: string | number;
    };
    entry: {
      channel?: string;
      to?: string;
      threadId?: string | number;
    };
  }) => boolean;
  setIdleTimeoutBySessionKey?: (params: {
    targetSessionKey: string;
    accountId?: string | null;
    idleTimeoutMs: number;
  }) => Array<{
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  }>;
  setMaxAgeBySessionKey?: (params: {
    targetSessionKey: string;
    accountId?: string | null;
    maxAgeMs: number;
  }) => Array<{
    boundAt: number;
    lastActivityAt: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  }>;
  createManager?: (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    | {
        stop: () => void | Promise<void>;
      }
    | Promise<{
        stop: () => void | Promise<void>;
      }>;
};

/** Security audit and DM policy hooks for a resolved account. */
export type ChannelSecurityAdapter<ResolvedAccount = unknown> = {
  applyConfigFixes?: (params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
  }) => ChannelDoctorConfigMutation | Promise<ChannelDoctorConfigMutation>;
  resolveDmPolicy?: ChannelAdapterCallback<
    (ctx: ChannelSecurityContext<ResolvedAccount>) => ChannelSecurityDmPolicy | null
  >;
  collectWarnings?: ChannelAdapterCallback<
    (ctx: ChannelSecurityContext<ResolvedAccount>) => Promise<string[]> | string[]
  >;
  collectAuditFindings?: ChannelAdapterCallback<
    (
      ctx: ChannelSecurityContext<ResolvedAccount> & {
        sourceConfig: OpenClawConfig;
        orderedAccountIds: string[];
        hasExplicitAccountPath: boolean;
      },
    ) =>
      | Promise<
          Array<{
            checkId: string;
            severity: "info" | "warn" | "critical";
            title: string;
            detail: string;
            remediation?: string;
          }>
        >
      | Array<{
          checkId: string;
          severity: "info" | "warn" | "critical";
          title: string;
          detail: string;
          remediation?: string;
        }>
  >;
};
