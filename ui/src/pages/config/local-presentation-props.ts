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
    chatShowTaskProgress:
      settings.chatShowTaskProgress ?? UI_APPEARANCE_DEFAULTS.chatShowTaskProgress,
    openLinksExternally: settings.openLinksExternally === true,
    chatCollapseTaskProgress: settings.chatCollapseTaskProgress === true,
    showAdvancedSettings: settings.showAdvancedSettings === true,
  };
}
