import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "../../components/confirm-dialog.ts";
import { currentDisplayConfig } from "../../lib/config/config-state-model.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { modelSettingPrimary, readModelSetting } from "../../lib/model-setting.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { PluginsPageDetail } from "./plugins-page-model.ts";

export async function confirmPluginRemoval(options: {
  pluginId: string;
  name: string;
  context: ApplicationContext;
  gateway: GatewayPageBinding;
  inspection: Promise<unknown> | undefined;
  detail: () => PluginsPageDetail | null;
}): Promise<boolean> {
  const { context, gateway } = options;
  const scope = gateway.capture();
  await options.inspection?.catch(() => {});
  const detail = options.detail();
  const providers =
    detail?.pluginId === options.pluginId ? detail.inspection?.declared.providers : undefined;
  if (providers?.length) {
    await context.runtimeConfig.ensureDisplayLoaded();
  }
  if (!scope || !gateway.isCurrent(scope)) {
    return false;
  }
  const config = currentDisplayConfig(context.runtimeConfig.state);
  const defaults = asOptionalRecord(asOptionalRecord(config?.agents)?.defaults);
  const primary = modelSettingPrimary(readModelSetting(defaults?.model)) ?? "";
  const provider = primary
    ? parseModelCatalogRef(splitTrailingAuthProfile(primary).model)?.provider
    : undefined;
  const unknown =
    providers === undefined ||
    (providers.length > 0 && (!config || (Boolean(primary) && !provider)));
  const affected = provider && providers?.some((id) => normalizeProviderId(id) === provider);
  const confirmation = {
    title: t("pluginsPage.removeConfirmTitle", { name: options.name }),
    message: t("pluginsPage.removeConfirmMessage"),
    confirmLabel: t("pluginsPage.remove"),
    danger: true,
  };
  if (!affected && !unknown) {
    return showConfirmDialog(confirmation);
  }
  const choice = await showConfirmChoiceDialog({
    ...confirmation,
    message:
      confirmation.message +
      " " +
      (unknown
        ? t("pluginsPage.removeModelCheckUnavailable")
        : t("pluginsPage.removeDefaultModelWarning", { model: primary })),
    alternativeLabel: t("pluginsPage.chooseAnotherModel"),
  });
  if (choice === "alternative" && gateway.isCurrent(scope)) {
    context.navigate("model-providers");
  }
  return choice === "confirm";
}
