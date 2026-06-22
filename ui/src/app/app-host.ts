import type { AgentsState } from "../pages/agents/data.ts";
// Shared Control UI host shapes used by app-level route and settings modules.
import type { AgentFilesState } from "../pages/agents/files.ts";
import type { AgentIdentityState } from "../pages/agents/identity.ts";
import type { AgentSkillsState } from "../pages/agents/skills.ts";
import type { ChannelsState } from "../pages/channels/data.ts";
import type { ConfigState } from "../pages/config/data.ts";
import type { CronState } from "../pages/cron/data.ts";
import type { DebugState } from "../pages/debug/data.ts";
import type { LogsState } from "../pages/logs/data.ts";
import type { NodesState } from "../pages/nodes/data.ts";
import type { DevicesState } from "../pages/nodes/devices.ts";
import type { ExecApprovalsState } from "../pages/nodes/exec-approvals.ts";
import type { SessionsState } from "../pages/sessions/data.ts";
import type { SkillWorkshopState } from "../pages/skill-workshop/data.ts";
import type { SkillsState } from "../pages/skills/data.ts";
import type { DreamingState, DreamingStatus } from "../ui/controllers/dreaming.ts";
import type { ModelAuthStatusState } from "../ui/controllers/model-auth-status.ts";
import type { PresenceState } from "../ui/controllers/presence.ts";
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
