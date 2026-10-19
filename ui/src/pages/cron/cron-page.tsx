import { createEffect, createMemo } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { createCronPage } from "./cron-page-state.ts";
import { CronRunTranscriptView } from "./run-transcript.tsx";
import { buildCronViewProps } from "./view-props.ts";
import { CronView } from "./view.tsx";

export function CronPageContent(props: { page: ReturnType<typeof createCronPage> }) {
  const revision = () => i18nRevision() + props.page.revision();
  const viewProps = createMemo(() => {
    revision();
    return buildCronViewProps(props.page);
  });
  const header = createMemo(() => {
    revision();
    const page = props.page;
    return {
      title: titleForRoute("cron"),
      subtitle: page.cron().cronSessionFilter
        ? t("cron.list.sessionFilter")
        : subtitleForRoute("cron"),
      filtered: Boolean(page.cron().cronSessionFilter),
      agents: page.inventories.agents.read().agentsList?.agents ?? [],
      selectedAgentId: page.context().agentSelection.state.scopeId,
    };
  });
  return (
    <>
      <SettingsPageHeader
        title={header().title}
        subtitle={header().subtitle}
        actions={
          header().filtered ? (
            <a
              class="btn"
              href={pathForRoute("cron", props.page.context().basePath)}
              onClick={(event: MouseEvent) => {
                if (shouldHandleNavigationClick(event)) {
                  event.preventDefault();
                  props.page.context().navigate("cron", { search: "" });
                }
              }}
            >
              {t("cron.list.showAll")}
            </a>
          ) : (
            <AgentScopeControl
              agents={header().agents}
              selection={props.page.context().agentSelection}
              selectedId={header().selectedAgentId}
            />
          )
        }
      />
      <CronRunTranscriptView transcript={props.page.runTranscript} revision={revision} />
      <SettingsWorkspace>
        <CronView {...viewProps()} />
      </SettingsWorkspace>
    </>
  );
}

function CronPageBody(props: { routeSearch?: string; host: HTMLElement }) {
  const context = useApplication();
  const page = createCronPage(
    () => context,
    () => props.host,
  );
  // Route changes retire the cron owner's transcript reads and retarget Gateway job queries.
  createEffect(
    () => props.routeSearch ?? "",
    (search) => page.setRouteSearch(search),
  );
  return <CronPageContent page={page} />;
}

export function CronPage(props: { routeSearch?: string }) {
  let host!: HTMLElement;
  return (
    <openclaw-cron-page ref={(element) => (host = element)}>
      <CronPageBody routeSearch={props.routeSearch} host={host} />
    </openclaw-cron-page>
  );
}
