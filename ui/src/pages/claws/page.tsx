import { createMemo, onSettled, Show } from "solid-js";
import { clawCatalogPackageNameFromPath, pathForRoute } from "../../app-route-paths.ts";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { AgentsHomePage } from "../agents-home/agents-home-page.tsx";
import { ClawsCatalogDialog } from "../agents-home/claws-catalog-dialog.tsx";
import { PluginDetailLoadingHero } from "../plugins/detail-loading-hero.tsx";
import { clawCreatorFlow } from "./creator-flow.ts";
import { clawDraftTargetFromSearch, type ClawDraftTarget } from "./draft-navigation.ts";
import type { ClawsRouteData } from "./route.ts";

function ClawDraftOpening(props: { target: ClawDraftTarget }) {
  const context = useApplication();
  onSettled(() => {
    const flow = clawCreatorFlow(context);
    if (props.target.draftId) {
      flow.open(props.target.agentId, props.target.draftId);
    } else {
      void flow.start(props.target.agentId);
    }
  });
  return (
    <SettingsPage wide carapace>
      <p role="status">{t("clawsDraft.openingChat")}</p>
    </SettingsPage>
  );
}

export function ClawsPage(props: { routeData: ClawsRouteData | undefined }) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  // Shell layout reports refresh route snapshots; only a changed query owns a new draft page.
  const draftSearch = createMemo(() => props.routeData?.location.search ?? "");
  const draftTarget = createMemo(() => clawDraftTargetFromSearch(draftSearch()));
  const connectedDraftTarget = () => {
    gateway.revision();
    return context.gateway.snapshot.client ? draftTarget() : null;
  };
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
            <PluginDetailLoadingHero />
          </section>
        </SettingsPage>
      }
    >
      <Show
        when={connectedDraftTarget()}
        keyed
        fallback={
          <Show when={packageName()} keyed fallback={<AgentsHomePage />}>
            {(selectedPackage) => (
              <ClawsCatalogDialog
                initialPackageName={selectedPackage}
                pageMode
                onClose={() =>
                  context.navigate("agents-home", {
                    pathname: pathForRoute("agents-home", context.basePath),
                  })
                }
                onAdded={() => void context.agents.refreshList()}
              />
            )}
          </Show>
        }
      >
        {(target) => <ClawDraftOpening target={target} />}
      </Show>
    </Show>
  );
}
