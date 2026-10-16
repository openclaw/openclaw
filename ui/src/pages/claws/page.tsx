import { createMemo, Show } from "solid-js";
import { clawCatalogPackageNameFromPath, pathForRoute } from "../../app-route-paths.ts";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { AgentsHomePage } from "../agents-home/agents-home-page.tsx";
import { ClawsCatalogDialog } from "../agents-home/claws-catalog-dialog.tsx";
import { clawDraftTargetFromSearch } from "./draft-navigation.ts";
import { ClawDraftPage } from "./draft-page.tsx";
import type { ClawsRouteData } from "./route.ts";

export function ClawsPage(props: { routeData: ClawsRouteData | undefined }) {
  const context = useApplication();
  // Shell layout reports refresh route snapshots; only a changed query owns a new draft page.
  const draftSearch = createMemo(() => props.routeData?.location.search ?? "");
  const draftTarget = createMemo(() => clawDraftTargetFromSearch(draftSearch()));
  const packageName = () =>
    props.routeData
      ? clawCatalogPackageNameFromPath(props.routeData.location.pathname, props.routeData.basePath)
      : null;
  return (
    <Show
      when={props.routeData}
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
        when={draftTarget()}
        keyed
        fallback={
          packageName() ? (
            <ClawsCatalogDialog
              initialPackageName={packageName()!}
              pageMode
              onClose={() =>
                context.navigate("agents-home", {
                  pathname: pathForRoute("agents-home", context.basePath),
                })
              }
              onAdded={() => void context.agents.refreshList()}
            />
          ) : (
            <AgentsHomePage />
          )
        }
      >
        {(target) => <ClawDraftPage target={target} />}
      </Show>
    </Show>
  );
}
