import { createEffect, createMemo } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
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
  const pageHeader = () => {
    revision();
    const page = props.page;
    return {
      filtered: Boolean(page.cron().cronSessionFilter),
      agents: page.inventories.agents.read().agentsList?.agents ?? [],
      selectedAgentId: page.context().agentSelection.state.scopeId,
    };
  };
  return (
    <>
      <HubPageHeader
        active="cron"
        subtitle={pageHeader().filtered ? t("cron.list.sessionFilter") : undefined}
        docsUrl="https://docs.openclaw.ai/automation/cron-jobs"
        actions={
          pageHeader().filtered ? (
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
              agents={pageHeader().agents}
              selection={props.page.context().agentSelection}
              selectedId={pageHeader().selectedAgentId}
            />
          )
        }
      />
      <CronRunTranscriptView transcript={props.page.runTranscript} revision={revision} />
      <SettingsWorkspace>
        <CronView
          {...viewProps()}
          busy={props.page.saving() || viewProps().busy}
          toggleSavingJobId={props.page.toggleSavingJobId()}
        />
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
