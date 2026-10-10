import { Show } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";

export type CustomPluginUiDisabledContext = Pick<
  ApplicationContext<"labs">,
  "basePath" | "navigate"
> & {
  readonly plugins: Pick<ApplicationContext["plugins"], "errors">;
};

export function CustomPluginUiDisabled(props: {
  context: CustomPluginUiDisabledContext | undefined;
  pluginId: string;
}) {
  return (
    <Show
      when={
        props.context?.plugins.errors.some(
          (diagnostic) =>
            diagnostic.pluginId === props.pluginId &&
            diagnostic.code === "custom-plugin-ui-disabled",
        )
          ? props.context
          : undefined
      }
    >
      {(context) => (
        <>
          <div class="card-title">{t("pluginUi.customPluginsDisabled")}</div>
          <p class="card-sub">{t("pluginUi.customPluginsEnableHint")}</p>
          <a
            class="btn btn--sm"
            href={pathForRoute("labs", context().basePath)}
            onClick={(event) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                context().navigate("labs");
              }
            }}
          >
            {t("pluginUi.openLabs")}
          </a>
        </>
      )}
    </Show>
  );
}
