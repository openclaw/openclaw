import { createMemo, onSettled, Show } from "solid-js";
import {
  clawCatalogPackageNameFromPath,
  pathForClawCatalogEntry,
  pathForRoute,
} from "../../app-route-paths.ts";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ClawsCatalogDialog } from "../agents-home/claws-catalog-dialog.tsx";
import { ClawsExplore } from "../agents-home/claws-explore.tsx";
import { PluginDetailLoadingHero } from "../plugins/detail-loading-hero.tsx";
import { isClawsAvailable } from "./availability.ts";
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

function ClawsLoading() {
  return (
    <SettingsPage wide carapace>
      <section class="plugin-catalog-detail plugin-catalog-detail--loading" role="status">
        <div class="plugin-catalog-detail__back skeleton" />
        <PluginDetailLoadingHero />
      </section>
    </SettingsPage>
  );
}

export function ClawsPage(props: { routeData: ClawsRouteData | undefined }) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const available = () => isClawsAvailable(runtimeConfig.read().state);
  // Query changes select a different draft; gateway reconnects may only resume the same one.
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
    <Show when={props.routeData && available() !== null} fallback={<ClawsLoading />}>
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
        <Show
          when={connectedDraftTarget()}
          keyed
          fallback={
            <Show
              when={packageName()}
              keyed
              fallback={
                <ClawsExplore
                  onSelect={(entry) =>
                    context.navigate("claws", {
                      pathname: pathForClawCatalogEntry(entry.packageName, context.basePath),
                    })
                  }
                />
              }
            >
              {(selectedPackage) => (
                <ClawsCatalogDialog
                  initialPackageName={selectedPackage}
                  onClose={() =>
                    context.navigate("claws", {
                      pathname: pathForRoute("claws", context.basePath),
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
    </Show>
  );
}
