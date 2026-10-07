import { UI_APPEARANCE_DEFAULTS, type UiSettings } from "../../app/settings.ts";

/** Project browser-local preferences into Settings without a second state owner. */
export function localPresentationProps(
  settings: UiSettings,
  applySettings: (patch: Partial<UiSettings>) => void,
) {
  return {
    terminalFontFamily: settings.terminalFontFamily,
    setTerminalFontFamily: (value: string | undefined) =>
      applySettings({ terminalFontFamily: value }),
    chatMessageMaxWidth: settings.chatMessageMaxWidth,
    setChatMessageMaxWidth: (value: string | undefined) =>
      applySettings({ chatMessageMaxWidth: value }),
    chatShowTaskProgress:
      settings.chatShowTaskProgress ?? UI_APPEARANCE_DEFAULTS.chatShowTaskProgress,
    setChatShowTaskProgress: (enabled: boolean) => applySettings({ chatShowTaskProgress: enabled }),
    openLinksExternally: settings.openLinksExternally === true,
    setOpenLinksExternally: (enabled: boolean) => applySettings({ openLinksExternally: enabled }),
    chatCollapseTaskProgress: settings.chatCollapseTaskProgress === true,
    setChatCollapseTaskProgress: (enabled: boolean) =>
      applySettings({ chatCollapseTaskProgress: enabled }),
    showAdvancedSettings: settings.showAdvancedSettings === true,
    setShowAdvancedSettings: (enabled: boolean) => applySettings({ showAdvancedSettings: enabled }),
  };
}
