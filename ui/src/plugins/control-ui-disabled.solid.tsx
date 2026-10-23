import { Show } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../lib/reactive/i18n.ts";

export type CustomPluginUiDisabledContext = {
  readonly plugins: Pick<ApplicationContext["plugins"], "errors">;
};

export function CustomPluginUiDisabled(props: {
  context: CustomPluginUiDisabledContext | undefined;
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
