import { html } from "lit";
import { subtitleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { renderMcpIntro } from "./mcp.ts";

export function renderConfigPageSubtitle(
  pageId: ConfigPageId,
  context: Pick<ApplicationContext, "nativeDeviceSettings" | "nativeNotifications">,
) {
  switch (pageId) {
    case "appearance":
      return html`${t("configView.appearance.intro")}
      ${renderLearnMoreLink("https://docs.openclaw.ai/web/control-ui")}`;
    case "mcp":
      return renderMcpIntro();
    case "security":
      return html`${t("quickSettings.security.intro")}
      ${renderLearnMoreLink("https://docs.openclaw.ai/gateway/security")}`;
    case "talk":
      return html`${t("talkPage.intro")}
      ${renderLearnMoreLink("https://docs.openclaw.ai/nodes/talk")}`;
    case "updates":
      return t("updates.page.intro");
    case "notifications": {
      const device = context.nativeDeviceSettings;
      if (
        !context.nativeNotifications &&
        device &&
        (device.snapshot === null || device.snapshot.device.platform === "ios")
      ) {
        return t("configView.notifications.iosNativeHint");
      }
      return subtitleForRoute(pageId);
    }
    default:
      return subtitleForRoute(pageId);
  }
}
