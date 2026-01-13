import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type {
  OutboundDeliveryResult,
  OutboundSendDeps,
} from "../../infra/outbound/deliver.js";
import type { PollInput } from "../../polls.js";
import type { RuntimeEnv } from "../../runtime.js";
import type {
  GatewayClientMode,
  GatewayClientName,
} from "../../utils/message-channel.js";
import type { ChatChannelId } from "../registry.js";
import type { ChannelMessageActionName as ChannelMessageActionNameFromList } from "./message-action-names.js";
import type { ChannelOnboardingAdapter } from "./onboarding-types.js";

export { CHANNEL_MESSAGE_ACTION_NAMES } from "./message-action-names.js";

export type ChannelId = ChatChannelId;

export type ChannelOutboundTargetMode = "explicit" | "implicit" | "heartbeat";

export type ChannelAgentTool = AgentTool<TSchema, unknown>;

export type ChannelAgentToolFactory = (params: {
  cfg?: ClawdbotConfig;
}) => ChannelAgentTool[];

export type ChannelSetupInput = {
  name?: string;
  token?: string;
  tokenFile?: string;
  botToken?: string;
  appToken?: string;
  signalNumber?: string;
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
  authDir?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  useEnv?: boolean;
};

export type ChannelStatusIssue = {
  channel: ChannelId;
  accountId: string;
  kind: "intent" | "permissions" | "config" | "auth" | "runtime";
  message: string;
  fix?: string;
};

export type ChannelAccountState =
  | "linked"
  | "not linked"
  | "configured"
  | "not configured"
  | "enabled"
  | "disabled";

export type ChannelSetupAdapter = {
  resolveAccountId?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string;
  }) => string;
  applyAccountName?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    name?: string;
  }) => ClawdbotConfig;
  applyAccountConfig: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => ClawdbotConfig;
  validateInput?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => string | null;
};

export type ChannelHeartbeatDeps = {
  webAuthExists?: () => Promise<boolean>;
  hasActiveWebListener?: () => boolean;
};

export type ChannelMeta = {
  id: ChannelId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
  order?: number;
  showConfigured?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
};

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  lastDisconnect?:
    | string
    | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
      }
    | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  mode?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  tokenSource?: string;
  botTokenSource?: string;
  appTokenSource?: string;
  baseUrl?: string;
  allowUnmentionedGroups?: boolean;
  cliPath?: string | null;
  dbPath?: string | null;
  port?: number | null;
  probe?: unknown;
  lastProbeAt?: number | null;
  audit?: unknown;
  application?: unknown;
  bot?: unknown;
};

export type ChannelLogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type ChannelConfigAdapter<ResolvedAccount> = {
  listAccountIds: (cfg: ClawdbotConfig) => string[];
  resolveAccount: (
    cfg: ClawdbotConfig,
    accountId?: string | null,
  ) => ResolvedAccount;
  defaultAccountId?: (cfg: ClawdbotConfig) => string;
  setAccountEnabled?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
    enabled: boolean;
  }) => ClawdbotConfig;
  deleteAccount?: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
  }) => ClawdbotConfig;
  isEnabled?: (account: ResolvedAccount, cfg: ClawdbotConfig) => boolean;
  disabledReason?: (account: ResolvedAccount, cfg: ClawdbotConfig) => string;
  isConfigured?: (
    account: ResolvedAccount,
    cfg: ClawdbotConfig,
  ) => boolean | Promise<boolean>;
  unconfiguredReason?: (
    account: ResolvedAccount,
    cfg: ClawdbotConfig,
  ) => string;
  describeAccount?: (
    account: ResolvedAccount,
    cfg: ClawdbotConfig,
  ) => ChannelAccountSnapshot;
  resolveAllowFrom?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  }) => string[] | undefined;
  formatAllowFrom?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
    allowFrom: Array<string | number>;
  }) => string[];
};

export type ChannelGroupContext = {
  cfg: ClawdbotConfig;
  groupId?: string | null;
  groupRoom?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
};

export type ChannelGroupAdapter = {
  resolveRequireMention?: (params: ChannelGroupContext) => boolean | undefined;
  resolveGroupIntroHint?: (params: ChannelGroupContext) => string | undefined;
};

export type ChannelOutboundContext = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  mediaUrl?: string;
  gifPlayback?: boolean;
  replyToId?: string | null;
  threadId?: number | null;
  accountId?: string | null;
  deps?: OutboundSendDeps;
};

export type ChannelPollResult = {
  messageId: string;
  toJid?: string;
  channelId?: string;
  conversationId?: string;
  pollId?: string;
};

export type ChannelPollContext = {
  cfg: ClawdbotConfig;
  to: string;
  poll: PollInput;
  accountId?: string | null;
};

export type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";
  chunker?: ((text: string, limit: number) => string[]) | null;
  textChunkLimit?: number;
  pollMaxOptions?: number;
  resolveTarget?: (params: {
    cfg?: ClawdbotConfig;
    to?: string;
    allowFrom?: string[];
    accountId?: string | null;
    mode?: ChannelOutboundTargetMode;
  }) => { ok: true; to: string } | { ok: false; error: Error };
  sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  sendPoll?: (ctx: ChannelPollContext) => Promise<ChannelPollResult>;
};

export type ChannelStatusAdapter<ResolvedAccount> = {
  defaultRuntime?: ChannelAccountSnapshot;
  buildChannelSummary?: (params: {
    account: ResolvedAccount;
    cfg: ClawdbotConfig;
    defaultAccountId: string;
    snapshot: ChannelAccountSnapshot;
  }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  probeAccount?: (params: {
    account: ResolvedAccount;
    timeoutMs: number;
    cfg: ClawdbotConfig;
  }) => Promise<unknown>;
  auditAccount?: (params: {
    account: ResolvedAccount;
    timeoutMs: number;
    cfg: ClawdbotConfig;
    probe?: unknown;
  }) => Promise<unknown>;
  buildAccountSnapshot?: (params: {
    account: ResolvedAccount;
    cfg: ClawdbotConfig;
    runtime?: ChannelAccountSnapshot;
    probe?: unknown;
    audit?: unknown;
  }) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>;
  logSelfId?: (params: {
    account: ResolvedAccount;
    cfg: ClawdbotConfig;
    runtime: RuntimeEnv;
    includeChannelPrefix?: boolean;
  }) => void;
  resolveAccountState?: (params: {
    account: ResolvedAccount;
    cfg: ClawdbotConfig;
    configured: boolean;
    enabled: boolean;
  }) => ChannelAccountState;
  collectStatusIssues?: (
    accounts: ChannelAccountSnapshot[],
  ) => ChannelStatusIssue[];
};

export type ChannelGatewayContext<ResolvedAccount = unknown> = {
  cfg: ClawdbotConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
};

export type ChannelLogoutResult = {
  cleared: boolean;
  loggedOut?: boolean;
  [key: string]: unknown;
};

export type ChannelLoginWithQrStartResult = {
  qrDataUrl?: string;
  message: string;
};

export type ChannelLoginWithQrWaitResult = {
  connected: boolean;
  message: string;
};

export type ChannelLogoutContext<ResolvedAccount = unknown> = {
  cfg: ClawdbotConfig;
  accountId: string;
  account: ResolvedAccount;
  runtime: RuntimeEnv;
  log?: ChannelLogSink;
};

export type ChannelPairingAdapter = {
  idLabel: string;
  normalizeAllowEntry?: (entry: string) => string;
  notifyApproval?: (params: {
    cfg: ClawdbotConfig;
    id: string;
    runtime?: RuntimeEnv;
  }) => Promise<void>;
};

export type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
  startAccount?: (
    ctx: ChannelGatewayContext<ResolvedAccount>,
  ) => Promise<unknown>;
  stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  loginWithQrStart?: (params: {
    accountId?: string;
    force?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
  }) => Promise<ChannelLoginWithQrStartResult>;
  loginWithQrWait?: (params: {
    accountId?: string;
    timeoutMs?: number;
  }) => Promise<ChannelLoginWithQrWaitResult>;
  logoutAccount?: (
    ctx: ChannelLogoutContext<ResolvedAccount>,
  ) => Promise<ChannelLogoutResult>;
};

export type ChannelAuthAdapter = {
  login?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
    runtime: RuntimeEnv;
    verbose?: boolean;
    channelInput?: string | null;
  }) => Promise<void>;
};

export type ChannelHeartbeatAdapter = {
  checkReady?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
    deps?: ChannelHeartbeatDeps;
  }) => Promise<{ ok: boolean; reason: string }>;
  resolveRecipients?: (params: {
    cfg: ClawdbotConfig;
    opts?: { to?: string; all?: boolean };
  }) => { recipients: string[]; source: string };
};

export type ChannelCapabilities = {
  chatTypes: Array<"direct" | "group" | "channel" | "thread">;
  polls?: boolean;
  reactions?: boolean;
  threads?: boolean;
  media?: boolean;
  nativeCommands?: boolean;
  blockStreaming?: boolean;
};

export type ChannelElevatedAdapter = {
  allowFromFallback?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  }) => Array<string | number> | undefined;
};

export type ChannelCommandAdapter = {
  enforceOwnerForCommands?: boolean;
  skipWhenConfigEmpty?: boolean;
};

export type ChannelSecurityDmPolicy = {
  policy: string;
  allowFrom?: Array<string | number> | null;
  policyPath?: string;
  allowFromPath: string;
  approveHint: string;
  normalizeEntry?: (raw: string) => string;
};

export type ChannelSecurityContext<ResolvedAccount = unknown> = {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  account: ResolvedAccount;
};

export type ChannelSecurityAdapter<ResolvedAccount = unknown> = {
  resolveDmPolicy?: (
    ctx: ChannelSecurityContext<ResolvedAccount>,
  ) => ChannelSecurityDmPolicy | null;
  collectWarnings?: (
    ctx: ChannelSecurityContext<ResolvedAccount>,
  ) => Promise<string[]> | string[];
};

export type ChannelMentionAdapter = {
  stripPatterns?: (params: {
    ctx: MsgContext;
    cfg: ClawdbotConfig | undefined;
    agentId?: string;
  }) => string[];
  stripMentions?: (params: {
    text: string;
    ctx: MsgContext;
    cfg: ClawdbotConfig | undefined;
    agentId?: string;
  }) => string;
};

export type ChannelStreamingAdapter = {
  blockStreamingCoalesceDefaults?: {
    minChars: number;
    idleMs: number;
  };
};

export type ChannelThreadingAdapter = {
  resolveReplyToMode?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  }) => "off" | "first" | "all";
  allowTagsWhenOff?: boolean;
  buildToolContext?: (params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
    hasRepliedRef?: { value: boolean };
  }) => ChannelThreadingToolContext | undefined;
};

export type ChannelThreadingContext = {
  Channel?: string;
  To?: string;
  ReplyToId?: string;
  ThreadLabel?: string;
};

export type ChannelThreadingToolContext = {
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
};

export type ChannelMessagingAdapter = {
  normalizeTarget?: (raw: string) => string | undefined;
};

export type ChannelMessageActionName = ChannelMessageActionNameFromList;

export type ChannelMessageActionContext = {
  channel: ChannelId;
  action: ChannelMessageActionName;
  cfg: ClawdbotConfig;
  params: Record<string, unknown>;
  accountId?: string | null;
  gateway?: {
    url?: string;
    token?: string;
    timeoutMs?: number;
    clientName: GatewayClientName;
    clientDisplayName?: string;
    mode: GatewayClientMode;
  };
  toolContext?: ChannelThreadingToolContext;
  dryRun?: boolean;
};

export type ChannelToolSend = {
  to: string;
  accountId?: string | null;
};

export type ChannelMessageActionAdapter = {
  listActions?: (params: { cfg: ClawdbotConfig }) => ChannelMessageActionName[];
  supportsAction?: (params: { action: ChannelMessageActionName }) => boolean;
  supportsButtons?: (params: { cfg: ClawdbotConfig }) => boolean;
  extractToolSend?: (params: {
    args: Record<string, unknown>;
  }) => ChannelToolSend | null;
  handleAction?: (
    ctx: ChannelMessageActionContext,
  ) => Promise<AgentToolResult<unknown>>;
};

// Channel docking: implement this contract in src/channels/plugins/<id>.ts.
// biome-ignore lint/suspicious/noExplicitAny: registry aggregates heterogeneous account types.
export type ChannelPlugin<ResolvedAccount = any> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
  // CLI onboarding wizard hooks for this channel.
  onboarding?: ChannelOnboardingAdapter;
  config: ChannelConfigAdapter<ResolvedAccount>;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount>;
  gatewayMethods?: string[];
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  auth?: ChannelAuthAdapter;
  elevated?: ChannelElevatedAdapter;
  commands?: ChannelCommandAdapter;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  messaging?: ChannelMessagingAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  // Channel-owned agent tools (login flows, etc.).
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};
