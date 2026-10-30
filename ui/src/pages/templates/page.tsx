import { createMemo, onSettled, Show } from "solid-js";
import {
  templateCatalogPackageNameFromPath,
  pathForTemplateCatalogEntry,
  pathForRoute,
} from "../../app-route-paths.ts";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { TemplatesCatalogDialog } from "../agents-home/templates-catalog-dialog.tsx";
import { TemplatesExplore } from "../agents-home/templates-explore.tsx";
import { PluginDetailLoadingHero } from "../plugins/detail-loading-hero.tsx";
import { isTemplatesAvailable } from "./availability.ts";
import { templateCreatorFlow } from "./creator-flow.ts";
import { templateDraftTargetFromSearch, type TemplateDraftTarget } from "./draft-navigation.ts";
import type { TemplatesRouteData } from "./route.ts";

function TemplateDraftOpening(props: { target: TemplateDraftTarget }) {
  const context = useApplication();
  onSettled(() => {
    const flow = templateCreatorFlow(context);
    if (props.target.draftId) {
      flow.open(props.target.agentId, props.target.draftId);
    } else {
      void flow.start(props.target.agentId);
    }
  });
  return (
    <SettingsPage wide carapace>
      <p role="status">{t("templatesDraft.openingChat")}</p>
    </SettingsPage>
  );
}

function TemplatesLoading() {
  return (
    <SettingsPage wide carapace>
      <section class="plugin-catalog-detail plugin-catalog-detail--loading" role="status">
        <div class="plugin-catalog-detail__back skeleton" />
        <PluginDetailLoadingHero />
      </section>
    </SettingsPage>
  );
}

export function TemplatesPage(props: { routeData: TemplatesRouteData | undefined }) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const available = () => isTemplatesAvailable(runtimeConfig.read().state);
  // Query changes select a different draft; gateway reconnects may only resume the same one.
  const draftSearch = createMemo(() => props.routeData?.location.search ?? "");
  const draftTarget = createMemo(() => templateDraftTargetFromSearch(draftSearch()));
  const connectedDraftTarget = () => {
    gateway.revision();
    return context.gateway.snapshot.client ? draftTarget() : null;
  };
  const packageName = () =>
    props.routeData
      ? templateCatalogPackageNameFromPath(
          props.routeData.location.pathname,
          props.routeData.basePath,
        )
      : null;

  return (
    <Show when={props.routeData && available() !== null} fallback={<TemplatesLoading />}>
      <Show
        when={available()}
        fallback={
          <SettingsPage wide carapace>
            <div class="callout warn" role="status">
              {t("templatesCatalog.disabled")}
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
                <TemplatesExplore
                  onSelect={(entry) =>
                    context.navigate("templates", {
                      pathname: pathForTemplateCatalogEntry(entry.packageName, context.basePath),
                    })
                  }
                />
              }
            >
              {(selectedPackage) => (
                <TemplatesCatalogDialog
                  initialPackageName={selectedPackage}
                  onClose={() =>
                    context.navigate("templates", {
                      pathname: pathForRoute("templates", context.basePath),
                    })
                  }
                  onAdded={() => void context.agents.refreshList()}
                />
              )}
            </Show>
          }
        >
          {(target) => <TemplateDraftOpening target={target} />}
        </Show>
      </Show>
    </Show>
  );
}
