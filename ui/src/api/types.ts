import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  ArtifactSummary as ProtocolArtifactSummary,
  CronJob as ProtocolCronJob,
  CronListParams,
  CronRunLogEntry as ProtocolCronRunLogEntry,
  CronRunsParams,
  ErrorShape,
  SessionsFilesListResult as ProtocolSessionsFilesListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ChannelsStatusResult } from "../../../packages/gateway-protocol/src/schema/channels.js";
import type {
  SessionEntryArchiveReason,
  SessionRow,
} from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { ModelAuthStatusResult } from "../../../src/gateway/server-methods/models-auth-status.js";
import type {
  GatewaySessionRow as GatewayWireSessionRow,
  GatewaySessionsDefaults as GatewayWireSessionsDefaults,
  SessionsPatchResult as GatewayWireSessionsPatchResult,
} from "../../../src/gateway/session-utils.types.js";
import type {
  GatewayContextWindowOption,
  GatewayThinkingLevelOption,
  SessionsListResultBase,
  SessionsPatchResultBase,
} from "../../../src/shared/session-types.js";
export type {
  AgentIdentityResult,
  ArtifactsDownloadResult as ArtifactDownloadResult,
  ConfigSchemaResponse,
  ModelsListResult as ModelCatalogResult,
  AgentsFileEntry as AgentFileEntry,
  AgentsFilesListResult,
  AgentsFilesGetResult,
  AgentsFilesSetResult,
  SessionsFilesGetResult as SessionWorkspaceGetResult,
  SessionsFilesSetResult as SessionWorkspaceSetResult,
  CronJob,
  CronRunLogEntry,
  CronScratchGetResult,
  UpdateAvailable,
  UpdateHoldResult,
  UpdateReportResult,
  UpdateScheduleState,
  ChannelsPairingAccount,
  ChannelsPairingApproveResult,
  ChannelsPairingListResult,
  ChannelsPairingRequest,
  SessionVisibility,
  SessionMembersListEvidenceResult,
  SessionsRewindResult,
  SessionsForkResult,
  SessionBranch,
  SessionsBranchesListResult,
  SessionsBranchesSwitchResult,
  CronCompactJob,
  ToolCatalogProfile,
  ToolsCatalogResult,
  ToolsGitHubStatusResult,
  ToolsGitHubAuthorizeStartResult,
  ToolsGitHubAuthorizePollResult,
  ToolsEffectiveEntry,
  ToolsEffectiveResult,
  ModelsProbeResult,
  SystemAgentSetupActivateParams,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
  WizardNextResult,
  WizardStep,
} from "../../../packages/gateway-protocol/src/index.js";
export type { ConfigUiHint, ConfigUiHints } from "../../../src/shared/config-ui-hints-types.js";
export type { SessionGoal } from "../../../src/config/sessions/types.js";
export type { FastMode } from "@openclaw/normalization-core/string-coerce";
export type {
  AgentsListResult,
  ModelChoice as ModelCatalogEntry,
  ModelCatalogProviderOutcome,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
export type { SessionRunStatus } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
export type ChannelsStatusSnapshot = ChannelsStatusResult;
export type ChannelUiMetaEntry = NonNullable<ChannelsStatusResult["channelMeta"]>[number];
export type ChannelAccountSnapshot = ChannelsStatusResult["channelAccounts"][string][number];

type WhatsAppSelf = {
  e164?: string | null;
  jid?: string | null;
};

type WhatsAppDisconnect = {
  at: number;
  status?: number | null;
  error?: string | null;
  loggedOut?: boolean | null;
};

export type WhatsAppStatus = {
  configured: boolean;
  linked: boolean;
  authAgeMs?: number | null;
  self?: WhatsAppSelf | null;
  running: boolean;
  connected: boolean;
  lastConnectedAt?: number | null;
  lastDisconnect?: WhatsAppDisconnect | null;
  reconnectAttempts: number;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

type ChannelProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
};

type ChannelStatus<Probe = ChannelProbe> = {
  configured: boolean;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: Probe | null;
  lastProbeAt?: number | null;
};

type TelegramProbe = ChannelProbe & {
  bot?: { id?: number | null; username?: string | null } | null;
  webhook?: { url?: string | null; hasCustomCert?: boolean | null } | null;
};

export type TelegramStatus = ChannelStatus<TelegramProbe> & {
  tokenSource?: string | null;
  mode?: string | null;
};

type DiscordProbe = ChannelProbe & {
  bot?: { id?: string | null; username?: string | null } | null;
};

export type DiscordStatus = ChannelStatus<DiscordProbe> & {
  tokenSource?: string | null;
};

export type GoogleChatStatus = ChannelStatus & {
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
};

type SlackIdentity = {
  id?: string | null;
  name?: string | null;
};

type SlackProbe = ChannelProbe & {
  bot?: SlackIdentity | null;
  team?: SlackIdentity | null;
};

export type SlackStatus = ChannelStatus<SlackProbe> & {
  botTokenSource?: string | null;
  appTokenSource?: string | null;
};

export type SignalStatus = ChannelStatus<ChannelProbe & { version?: string | null }> & {
  baseUrl: string;
};

export type IMessageStatus = ChannelStatus<Pick<ChannelProbe, "ok" | "error">> & {
  cliPath?: string | null;
  dbPath?: string | null;
};

export type NostrProfile = {
  name?: string | null;
  displayName?: string | null;
  about?: string | null;
  picture?: string | null;
  banner?: string | null;
  website?: string | null;
  nip05?: string | null;
  lud16?: string | null;
};

export type NostrStatus = {
  configured: boolean;
  publicKey?: string | null;
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  profile?: NostrProfile | null;
};

type ConfigSnapshotIssue = { path: string; message: string };

export type ConfigSnapshot = {
  writeError?: ErrorShape;
  path?: string | null;
  exists?: boolean | null;
  raw?: string | null;
  hash?: string | null;
  configRevisionHash?: string | null;
  appliedConfigHash?: string | null;
  parsed?: unknown;
  valid?: boolean | null;
  sourceConfig?: Record<string, unknown> | null;
  resolved?: Record<string, unknown> | null;
  runtimeConfig?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  issues?: ConfigSnapshotIssue[] | null;
};

export type { PresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
export type { GatewayWireSessionsDefaults as GatewaySessionsDefaults };
export type { GatewayAgentRow } from "../../../src/shared/session-types.js";
export type { GatewayContextWindowOption, GatewayThinkingLevelOption };

// The workspace view joins file results with separately fetched artifacts.
export type SessionWorkspaceListResult = ProtocolSessionsFilesListResult & {
  artifacts?: ProtocolArtifactSummary[];
};

export type GatewaySessionRow = Omit<GatewayWireSessionRow, "archivedBy" | "updatedAt"> &
  Pick<SessionRow, "archivedBy" | "updatedAt"> & {
    /** Transient UI-owned Swarm note overlays, not persisted session fields. */
    swarmPhase?: string;
    swarmPhaseRank?: number;
    swarmLog?: string;
    icon?: string;
    channelAvatarUrl?: string;
    surface?: string;
    room?: string;
    /** UI-local timestamp for the runtimeMs sample; absent on raw Gateway rows. */
    runtimeSampledAt?: number;
  };

export type SessionsListResult = SessionsListResultBase<
  GatewayWireSessionsDefaults,
  GatewaySessionRow
>;

export type SessionsPatchResult = SessionsPatchResultBase<{
  sessionId: string;
  category?: GatewaySessionRow["category"];
  updatedAt?: number;
  createdAt?: number;
  pinnedAt?: number;
  lastReadAt?: number;
  lastActivityAt?: number;
  lastInteractionAt?: number;
  permissionMode?: GatewaySessionRow["permissionMode"];
  nativeRuntimeConsent?: string;
  modelOverrideSource?: GatewayWireSessionsPatchResult["entry"]["modelOverrideSource"];
  boardFace?: GatewaySessionRow["boardFace"];
  boardPresentation?: GatewaySessionRow["boardPresentation"];
  archivedAt?: number;
  archivedBy?: GatewaySessionRow["archivedBy"];
  archiveReason?: SessionEntryArchiveReason;
  /** Present only while an explicit mark-unread marker owns the row. */
  markedUnreadAt?: number;
  contextWindow?: string;
  thinkingLevel?: string;
  fastMode?: FastMode;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
}> &
  Pick<GatewayWireSessionsPatchResult, "resolved">;

export type { CostUsageSummary, SessionsUsageResult } from "../pages/usage/data-types.ts";

export type CronRunStatus = NonNullable<ProtocolCronRunLogEntry["status"]>;
export type CronDeliveryStatus = NonNullable<ProtocolCronRunLogEntry["deliveryStatus"]>;
export type CronJobsEnabledFilter = NonNullable<CronListParams["enabled"]>;
export type CronJobsScheduleKindFilter = NonNullable<CronListParams["scheduleKind"]>;
export type CronJobsTriggerFilter = NonNullable<CronListParams["trigger"]>;
export type CronJobsSortBy = NonNullable<CronListParams["sortBy"]>;
export type CronRunScope = NonNullable<CronRunsParams["scope"]>;
export type CronRunsStatusValue = NonNullable<CronRunsParams["statuses"]>[number];
export type CronRunsStatusFilter = NonNullable<CronRunsParams["status"]>;
export type CronSortDir = NonNullable<CronListParams["sortDir"]>;
export type CronPayload = ProtocolCronJob["payload"];

export type CronStatus = {
  enabled: boolean;
  triggersEnabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; enqueued: true; runId: string }
  | {
      ok: true;
      ran: false;
      reason:
        | "not-due"
        | "already-running"
        | "restart-recovery-pending"
        | "invalid-spec"
        | "stopped";
    }
  | { ok: false };

export type CronJobsListResult<Row = ProtocolCronJob> = {
  jobs: Row[];
  snapshotRevision: string;
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
};

export type CronRunsResult = {
  entries: ProtocolCronRunLogEntry[];
  total?: number;
  limit?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
};

export type {
  SkillStatusEntry,
  SkillStatusReport,
} from "../../../src/skills/discovery/status.types.js";
export type { ClawHubSkillStatusLink as SkillClawHubLink } from "../../../src/skills/lifecycle/workspace-types.js";

export type StatusSummary = Record<string, unknown>;

export type HealthSnapshot = Record<string, unknown>;

export type {
  ModelAuthStatusProvider,
  ModelAuthStatusProfile,
  ModelAuthStatusResult,
} from "../../../src/gateway/server-methods/models-auth-status.js";
export type ProviderLoginOption = NonNullable<
  NonNullable<ModelAuthStatusResult["providerCapabilities"]>[number]["loginOptions"]
>[number];
export type ProviderSetupOption = NonNullable<
  NonNullable<ModelAuthStatusResult["providerCapabilities"]>[number]["setupOptions"]
>[number];
