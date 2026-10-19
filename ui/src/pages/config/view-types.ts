import type { JSX } from "@solidjs/web";
import type { WebPushSnapshot } from "../../app/web-push.ts";
import type { createConfigPage } from "./config-page-state.ts";
import type { SettingsMediaDeviceState } from "./view-state.ts";
import type { TabIconViewProps } from "./view-tab-icon.tsx";

type ConfigPageProps = ReturnType<ReturnType<typeof createConfigPage>["configProps"]>;
// Rendering does not consume the completion values returned by owner callbacks.
type ConfigData = {
  [Key in keyof ConfigPageProps]: ConfigPageProps[Key] extends (...args: infer Args) => unknown
    ? (...args: Args) => void
    : ConfigPageProps[Key];
};

type ConfigViewOptions = Partial<
  Pick<
    ConfigData,
    | "mutationAllowed"
    | "openFileAllowed"
    | "rawDraftPending"
    | "rawAvailable"
    | "showModeToggle"
    | "showSectionDocs"
    | "localeOverride"
    | "localeResetValue"
    | "themeCatalog"
    | "onRetryThemeCatalog"
    | "customThemeImportExpanded"
    | "onOpenCustomThemeImport"
    | "terminalFontFamily"
    | "forceShowAdvanced"
    | "forceAdvancedSection"
    | "sessionObserverEnabled"
    | "sessionObserverUtilityModel"
    | "sessionObserverResolvedModel"
    | "sessionObserverModelsUnavailable"
    | "sessionObserverDisabled"
    | "setSessionObserverEnabled"
    | "setSessionObserverUtilityModel"
    | "lobsterdexHref"
    | "onOpenLobsterdex"
    | "onMicrophoneRefresh"
    | "onMicrophoneSelect"
    | "onCameraRefresh"
    | "onCameraSelect"
    | "pluginsHref"
    | "sessionSourcePluginsLoading"
    | "configPath"
    | "navRootLabel"
    | "showRootTab"
    | "includeVirtualSections"
    | "nativeNotifications"
    | "onNativeNotificationsRequestPermission"
    | "onNativeNotificationsSendTest"
    | "onWebPushSubscribe"
    | "onWebPushUnsubscribe"
    | "onWebPushTest"
    | "onWebPushSetUserPreferences"
    | "onWebPushSetDevicePreferences"
    | "chatMessageMaxWidth"
    | "chatFollowUpMode"
    | "openLinksInControlUiBrowser"
  >
> & {
  textScale: number;
  hiddenSessionCatalogIds: ReadonlySet<string>;
  sessionObserverModels?: readonly ConfigPageProps["sessionObserverModels"][number][];
  installedSessionSourcePluginIds?: ReadonlySet<string> | null;
  microphone?: SettingsMediaDeviceState;
  camera?: SettingsMediaDeviceState;
  onOpenFile?: () => void;
  webPush?: WebPushSnapshot;
  includeSections?: readonly string[];
  excludeSections?: readonly string[];
  /** Embedded schema editors can provide their own section chrome. */
  embeddedEditor?: boolean;
  sectionPrelude?: JSX.Element;
  renderSection?: (editor: JSX.Element) => JSX.Element;
  settingsLayout?: "tabs" | "accordion";
};

export type ConfigProps = Omit<ConfigData, keyof ConfigViewOptions | keyof TabIconViewProps> &
  ConfigViewOptions &
  TabIconViewProps;
