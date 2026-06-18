// Shared Control UI host shapes used by app-level route and settings modules.
import type { RouteId } from "../app-routes.ts";
import type { AgentFilesState } from "../ui/controllers/agent-files.ts";
import type { AgentIdentityState } from "../ui/controllers/agent-identity.ts";
import type { AgentSkillsState } from "../ui/controllers/agent-skills.ts";
import type { AgentsState } from "../ui/controllers/agents.ts";
import type { ChannelsState } from "../ui/controllers/channels.ts";
import type { ConfigState } from "../ui/controllers/config.ts";
import type { CronState } from "../ui/controllers/cron.ts";
import type { DebugState } from "../ui/controllers/debug.ts";
import type { DevicesState } from "../ui/controllers/devices.ts";
import type { DreamingState, DreamingStatus } from "../ui/controllers/dreaming.ts";
import type { ExecApprovalsState } from "../ui/controllers/exec-approvals.ts";
import type { LogsState } from "../ui/controllers/logs.ts";
import type { ModelAuthStatusState } from "../ui/controllers/model-auth-status.ts";
import type { NodesState } from "../ui/controllers/nodes.ts";
import type { PresenceState } from "../ui/controllers/presence.ts";
import type { SessionsState } from "../ui/controllers/sessions.ts";
import type { SkillWorkshopState } from "../ui/controllers/skill-workshop.ts";
import type { SkillsState } from "../ui/controllers/skills.ts";
import type { UsageState } from "../ui/controllers/usage.ts";
import type { UiSettings } from "../ui/storage.ts";
import type { ResolvedTheme, ThemeMode, ThemeName } from "../ui/theme.ts";
import type { AgentsListResult, AttentionItem } from "../ui/types.ts";

export type SettingsHost = {
  settings: UiSettings;
  userName?: string | null;
  userAvatar?: string | null;
  password?: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  themeResolved: ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  routeId: RouteId;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  agentsList?: AgentsListResult | null;
  selectedAgentId?: string | null;
  agentsSelectedId?: string | null;
  agentsPanel?: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
  pendingGatewayUrl?: string | null;
  systemThemeCleanup?: (() => void) | null;
  pendingGatewayToken?: string | null;
  requestUpdate?: () => void;
  updateComplete?: Promise<unknown>;
  controlUiRefreshSeq?: number;
  controlUiRoutePaintSeq?: number;
  controlUiOverviewRefreshSeq?: number;
  controlUiCronRefreshSeq?: number;
  sessionsChangedReloadTimer?: number | ReturnType<typeof globalThis.setTimeout> | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: DreamingStatus | null;
  dreamingModeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
};

export type SettingsAppHost = SettingsHost &
  AgentFilesState &
  AgentIdentityState &
  AgentSkillsState &
  AgentsState &
  ChannelsState &
  ConfigState &
  CronState &
  DebugState &
  DevicesState &
  DreamingState &
  ExecApprovalsState &
  LogsState &
  NodesState &
  PresenceState &
  SessionsState &
  SkillsState &
  SkillWorkshopState &
  ModelAuthStatusState &
  UsageState & {
    overviewLogCursor: number | null;
    overviewLogLines: string[];
    attentionItems: AttentionItem[];
    hello: { auth?: { role?: string; scopes?: string[] } } | null;
  };
