import { html, nothing } from "lit";
import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { i18n } from "../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectI18n, t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/lit-content.tsx";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { CronPageController } from "./cron-page-controller.ts";
import { CronRunTranscriptView } from "./run-transcript.tsx";
import { CronView } from "./view.tsx";

export function CronPageContent(props: { controller: CronPageController; revision: () => number }) {
  const translations = projectI18n(i18n);
  const viewProps = createMemo(() => {
    props.revision();
    translations.revision();
    return props.controller.viewProps;
  });
  const header = createMemo(() => {
    props.revision();
    translations.revision();
    return {
      title: titleForRoute("cron"),
      subtitle: props.controller.cron.cronSessionFilter
        ? t("cron.list.sessionFilter")
        : subtitleForRoute("cron"),
    };
  });
  const headerActions = createMemo(() => {
    props.revision();
    translations.revision();
    const controller = props.controller;
    return controller.cron.cronSessionFilter
      ? html`<a
          class="btn"
          href=${pathForRoute("cron", controller.context.basePath)}
          @click=${(event: MouseEvent) => {
            if (shouldHandleNavigationClick(event)) {
              event.preventDefault();
              controller.context.navigate("cron", { search: "" });
            }
          }}
          >${t("cron.list.showAll")}</a
        >`
      : renderAgentScopeControl({
          agents: controller.agentsList?.agents ?? [],
          selection: controller.context.agentSelection,
        });
  });
  createEffect(
    () => props.revision(),
    () => props.controller.afterRender(),
  );
  return (
    <>
      <SettingsPageHeader
        title={header().title}
        subtitle={header().subtitle}
        actions={headerActions() === nothing ? undefined : <LitContent value={headerActions()} />}
      />
      <CronRunTranscriptView
        controller={props.controller.runTranscript}
        revision={props.revision}
      />
      <SettingsWorkspace>
        <CronView {...viewProps()} />
      </SettingsWorkspace>
    </>
  );
}

export function CronPage(props: { routeSearch?: string; host: HTMLElement }) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const controller = new CronPageController(
    context,
    untrack(() => props.host),
    () => setRevision((value) => value + 1),
  );
  createEffect(
    () => props.routeSearch ?? "",
    (search) => controller.setRouteSearch(search),
  );
  onSettled(() => controller.activate());
  onCleanup(() => controller.dispose());
  return <CronPageContent controller={controller} revision={revision} />;
}

export const cronPageComponent = {
  header: true,
  render: (search: unknown) => html`<openclaw-cron-page
    .routeSearch=${typeof search === "string" ? search : ""}
  ></openclaw-cron-page>`,
};

// Module re-evaluation can retain the shared custom-element registry.
if (!customElements.get("openclaw-cron-page")) {
  defineSolidBridge<{ routeSearch: string }>(
    "openclaw-cron-page",
    (props, host) => <CronPage routeSearch={props.routeSearch} host={host} />,
    { properties: { routeSearch: { default: "", attribute: false } } },
  );
}
