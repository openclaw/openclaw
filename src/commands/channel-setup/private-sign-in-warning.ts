import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import { t } from "../../wizard/i18n/index.js";

export function getChannelPrivateSignInWarning(
  plugin: Pick<ChannelSetupPlugin, "capabilities" | "meta">,
): string | undefined {
  if (plugin.capabilities.requesterPrivateMessages === true) {
    return undefined;
  }
  return t("wizard.channels.privateSignInWarning", { label: plugin.meta.label });
}
