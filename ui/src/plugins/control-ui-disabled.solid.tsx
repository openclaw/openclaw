import { Show } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../lib/reactive/i18n.ts";

export function CustomPluginUiDisabled(props: {
  context: { readonly plugins: Pick<ApplicationContext["plugins"], "errors"> } | undefined;
  pluginId: string;
}) {
  return (
    <Show
      when={props.context?.plugins.errors.some(
        (diagnostic) =>
          diagnostic.pluginId === props.pluginId && diagnostic.code === "custom-plugin-ui-disabled",
      )}
    >
      <div class="card-title">{t("pluginUi.customPluginsDisabled")}</div>
      <p class="card-sub">{t("pluginUi.customPluginsEnableHint")}</p>
    </Show>
  );
}
