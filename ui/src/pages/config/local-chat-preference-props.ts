import { UI_APPEARANCE_DEFAULTS, type UiSettings } from "../../app/settings.ts";
import type { ConfigProps } from "./view-types.ts";

export function createLocalChatPreferenceProps(
  settings: UiSettings,
  applySettings: (patch: Partial<UiSettings>) => void,
): Pick<
  ConfigProps,
  | "chatMessageMaxWidth"
  | "setChatMessageMaxWidth"
  | "chatShowTaskProgress"
  | "setChatShowTaskProgress"
  | "chatCollapseTaskProgress"
  | "setChatCollapseTaskProgress"
  | "openLinksExternally"
  | "setOpenLinksExternally"
> {
  return {
    chatMessageMaxWidth: settings.chatMessageMaxWidth,
    setChatMessageMaxWidth: (value) => applySettings({ chatMessageMaxWidth: value }),
    chatShowTaskProgress:
      settings.chatShowTaskProgress ?? UI_APPEARANCE_DEFAULTS.chatShowTaskProgress,
    setChatShowTaskProgress: (enabled) => applySettings({ chatShowTaskProgress: enabled }),
    openLinksExternally: settings.openLinksExternally === true,
    setOpenLinksExternally: (enabled) => applySettings({ openLinksExternally: enabled }),
    chatCollapseTaskProgress: settings.chatCollapseTaskProgress === true,
    setChatCollapseTaskProgress: (enabled) => applySettings({ chatCollapseTaskProgress: enabled }),
  };
}
