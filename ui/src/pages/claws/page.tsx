import { Show } from "solid-js";
import {
  clawCatalogPackageNameFromPath,
  pathForClawCatalogEntry,
  pathForRoute,
} from "../../app-route-paths.ts";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ClawsCatalogDialog } from "../agents-home/claws-catalog-dialog.tsx";
import { ClawsExplore } from "../agents-home/claws-explore.tsx";
import { isClawsAvailable } from "./availability.ts";
import type { ClawsRouteData } from "./route.ts";

export function ClawsPage(props: { routeData: ClawsRouteData | undefined }) {
  const context = useApplication();
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const available = () => isClawsAvailable(runtimeConfig.read().state);
  const packageName = () =>
    props.routeData
      ? clawCatalogPackageNameFromPath(props.routeData.location.pathname, props.routeData.basePath)
      : null;
  return (
    <Show
      when={props.routeData && available() !== null}
      fallback={
        <SettingsPage wide carapace>
          <section class="plugin-catalog-detail plugin-catalog-detail--loading" role="status">
            <div class="plugin-catalog-detail__back skeleton" />
            <div class="plugin-catalog-detail__hero">
              <div class="plugin-catalog-detail__icon skeleton" />
              <div>
                <div class="plugin-catalog-detail__loading-title skeleton" />
                <div class="plugin-catalog-detail__loading-publisher skeleton" />
                <div class="plugin-catalog-detail__loading-summary skeleton" />
              </div>
            </div>
          </section>
        </SettingsPage>
      }
    >
      <Show
        when={available()}
        fallback={
          <SettingsPage wide carapace>
            <div class="callout warn" role="status">
              {t("clawsCatalog.disabled")}
            </div>
          </SettingsPage>
        }
      >
        {packageName() ? (
          <ClawsCatalogDialog
            initialPackageName={packageName()!}
            pageMode
            onClose={() =>
              context.navigate("claws", {
                pathname: pathForRoute("claws", context.basePath),
              })
            }
            onAdded={() => void context.agents.refreshList()}
          />
        ) : (
          <ClawsExplore
            onSelect={(entry) =>
              context.navigate("claws", {
                pathname: pathForClawCatalogEntry(entry.packageName, context.basePath),
              })
            }
          />
        )}
      </Show>
    </Show>
  );
}
