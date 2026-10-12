import type { nothing, TemplateResult } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type {
  WebPushDevicePreferences,
  WebPushNotificationPreferences,
} from "../../../../packages/gateway-protocol/src/schema/push.js";
import type { ConfigUiHints, ModelCatalogEntry } from "../../api/types.ts";
import type { NativeNotificationsCapability } from "../../app/native-notifications.ts";
import type { ServerUiPrefProvenance } from "../../app/server-prefs.ts";
import type { ChatSendShortcut, UiSettings } from "../../app/settings.ts";
import type { ThemeCatalogSnapshot } from "../../app/theme-catalog.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import type { TypefaceId } from "../../app/typography.ts";
import type { WebPushSnapshot } from "../../app/web-push.ts";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import type { ConfigSchemaAnalysis } from "../../components/config-form.ts";
import type { Locale } from "../../i18n/index.ts";
import type { RealtimeTalkInputDevice } from "../chat/talk/input.ts";
import type { SessionObserverModelSelection } from "./session-observer-settings.ts";
import type { TabIconViewProps } from "./view-tab-icon.ts";

type SettingsMediaDeviceState = {
  devices: RealtimeTalkInputDevice[];
  permissionRequired: boolean;
  selectedDeviceId: string;
  loading: boolean;
  error: string | null;
};

type ConfigFormMode = "form" | "raw";

export type ConfigDiffPath = string[];
export type ConfigDiffEntry = { path: ConfigDiffPath; from: unknown; to: unknown };
type RawDiffCache = {
  original: string;
  current: string;
  diff: ConfigDiffEntry[];
};
type SchemaAnalysisCache = {
  schema: JsonSchema | null;
  includeKey: string;
  excludeKey: string;
  analysis: ConfigSchemaAnalysis;
};

export type ConfigViewState = {
  rawRevealed: boolean;
  rawDiffOpen: boolean;
  envRevealed: boolean;
  validityDismissed: boolean;
  revealedSensitivePaths: Set<string>;
  lastCustomThemeImportFocusToken: number | null;
  rawDiffCache?: RawDiffCache;
  schemaAnalysisCache?: SchemaAnalysisCache;
  lastConfigContextKey: string | null;
  lastFormModeForScroll: ConfigFormMode | null;
};

type AppearancePreferences = Required<
  Pick<
    UiSettings,
    | "sidebarLiveActivity"
    | "openLinksExternally"
    | "chatShowTaskProgress"
    | "chatCollapseTaskProgress"
    | "showAdvancedSettings"
    | "lobsterPetVisits"
    | "sessionDeleteConfirm"
    | "lobsterPetSounds"
    | "chatSendShortcut"
    | "catalogOpenTarget"
    | "composerHoldToRecord"
  >
> &
  Pick<UiSettings, "chatMessageMaxWidth" | "chatFollowUpMode">;

export interface ConfigProps extends TabIconViewProps, AppearancePreferences {
  onAppearanceChange: (patch: Partial<AppearancePreferences>) => void;
  raw: string;
  originalRaw: string;
  valid: boolean | null;
  issues: unknown[];
  loading: boolean;
  saving: boolean;
  applying: boolean;
  /** App updater running; config writes and restarts are interlocked. */
  updating: boolean;
  connected: boolean;
  mutationAllowed?: boolean;
  openFileAllowed?: boolean;
  schema: unknown;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: ConfigFormMode;
  /** Capability-authoritative unsaved raw draft, independent of the display toggle. */
  rawDraftPending?: boolean;
  viewState: ConfigViewState;
  rawAvailable?: boolean;
  showModeToggle?: boolean;
  /** Set when the form renders under a composite page's custom rows; an empty
   *  schema section stays silent instead of claiming the page is empty. */
  embeddedEditor?: boolean;
  /** Control UI rows that belong to the active schema section but are not Gateway config. */
  sectionPrelude?: TemplateResult;
  showSectionDocs?: boolean;
  /** Curated content inside the active section; receives the canonical schema editor. */
  renderSection?: (editor: TemplateResult | typeof nothing) => TemplateResult;
  formValue: Record<string, unknown> | null;
  activeSection: string | null;
  activeSubsection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: ConfigFormMode) => void;
  onViewStateChange: () => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onFormRemove: (path: Array<string | number>) => void;
  onSectionChange: (section: string | null) => void;
  onSubsectionChange: (section: string | null) => void;
  onSave: () => void;
  onRawDiscard: () => void;
  onOpenFile?: () => void;
  theme: ThemeName;
  themeOverridden: boolean;
  themeProvenance: ServerUiPrefProvenance;
  themeResetValue: ThemeName;
  themeMode: ThemeMode;
  themeModeOverridden: boolean;
  themeModeProvenance: ServerUiPrefProvenance;
  themeModeResetValue: ThemeMode;
  fontUi: TypefaceId | undefined;
  fontChat: TypefaceId | undefined;
  fontUiProvenance: ServerUiPrefProvenance;
  fontChatProvenance: ServerUiPrefProvenance;
  setFontUi: (font: TypefaceId | undefined) => void;
  setFontChat: (font: TypefaceId | undefined) => void;
  accent: string | undefined;
  accentProvenance: ServerUiPrefProvenance;
  accentResetValue: string | undefined;
  systemLocale: Locale;
  localeOverride?: Locale;
  localeOverridden: boolean;
  localeProvenance: ServerUiPrefProvenance;
  localeResetValue?: Locale;
  onLocaleChange: (locale: Locale | undefined) => void;
  themeCatalog?: ThemeCatalogSnapshot;
  onRetryThemeCatalog?: () => void;
  setTheme: (theme: ThemeName) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setAccent: (accent: string | undefined) => void;
  hasCustomTheme: boolean;
  customThemeLabel: string | null;
  customThemeSourceUrl: string | null;
  customThemeImportUrl: string;
  customThemeImportBusy: boolean;
  customThemeImportMessage: { kind: "success" | "error"; text: string } | null;
  customThemeImportExpanded?: boolean;
  customThemeImportFocusToken?: number;
  onCustomThemeImportUrlChange: (next: string) => void;
  onImportCustomTheme: () => void;
  onClearCustomTheme: () => void;
  onOpenCustomThemeImport?: () => void;
  textScale: number;
  textScaleOverridden: boolean;
  setTextScale: (value: number) => void;
  hiddenSessionCatalogIds: ReadonlySet<string>;
  hiddenSessionCatalogLabels: ReadonlyMap<string, string>;
  setSessionCatalogHidden: (catalogId: string, hidden: boolean) => void;
  terminalFontFamily?: string;
  setTerminalFontFamily: (value: string | undefined) => void;
  forceShowAdvanced?: boolean;
  forceAdvancedSection?: string | null;
  sessionObserverEnabled?: boolean;
  sessionObserverUtilityModel?: string;
  sessionObserverResolvedModel?: SystemInfoResult["defaultAgentUtilityModel"];
  sessionObserverModels?: readonly ModelCatalogEntry[];
  sessionObserverModelsUnavailable?: boolean;
  sessionObserverDisabled?: boolean;
  setSessionObserverEnabled?: (enabled: boolean) => void;
  setSessionObserverUtilityModel?: (selection: SessionObserverModelSelection) => void;
  lobsterdexHref?: string;
  onOpenLobsterdex?: () => void;
  chatSendShortcutOverridden: boolean;
  chatSendShortcutProvenance: ServerUiPrefProvenance;
  chatSendShortcutResetValue: ChatSendShortcut;
  chatFollowUpModeOverridden: boolean;
  chatFollowUpModeProvenance: ServerUiPrefProvenance;
  serverQueueMode: QueueMode | undefined;
  resetChatFollowUpMode: () => void;
  microphone?: SettingsMediaDeviceState;
  onMicrophoneRefresh?: () => void;
  onMicrophoneSelect?: (deviceId: string) => void;
  camera?: SettingsMediaDeviceState;
  onCameraRefresh?: () => void;
  onCameraSelect?: (deviceId: string) => void;
  gatewayUrl: string;
  pluginsHref?: string;
  installedSessionSourcePluginIds?: ReadonlySet<string> | null;
  sessionSourcePluginsLoading?: boolean;
  assistantName: string;
  configPath?: string | null;
  navRootLabel?: string;
  showRootTab?: boolean;
  includeSections?: string[];
  excludeSections?: string[];
  includeVirtualSections?: boolean;
  /** Layout mode: "tabs" (default flat scroll) or "accordion" (grouped collapsible). */
  settingsLayout?: "tabs" | "accordion";
  nativeNotifications?: NativeNotificationsCapability["snapshot"];
  onNativeNotificationsRequestPermission?: () => void;
  onNativeNotificationsSendTest?: () => void;
  webPush?: WebPushSnapshot;
  onWebPushSubscribe?: () => void;
  onWebPushUnsubscribe?: () => void;
  onWebPushTest?: () => void;
  onWebPushSetUserPreferences?: (preferences: WebPushNotificationPreferences) => void;
  onWebPushSetDevicePreferences?: (preferences: WebPushDevicePreferences) => void;
}
