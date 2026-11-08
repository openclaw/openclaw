import { createEffect, createMemo, Loading } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { createMediaQuery } from "../../lib/reactive/platform.ts";
import { createCronPage } from "./cron-page-state.ts";
import { CronRunTranscriptView } from "./run-transcript.tsx";
import { HistoryButton } from "./view-controls.tsx";
import { buildCronViewProps } from "./view-props.ts";
import { CronView } from "./view.tsx";

const PHONE_LAYOUT_QUERY = "(max-width: 560px)";

export function CronPageContent(props: { page: ReturnType<typeof createCronPage> }) {
  const phoneLayout = createMediaQuery(
    PHONE_LAYOUT_QUERY,
    globalThis.matchMedia?.(PHONE_LAYOUT_QUERY).matches ?? false,
  );
  const revision = () => i18nRevision() + props.page.revision();
  // Search publications must not invalidate the retained rows' permission branches.
  // Sample values because Gateway auth and identity snapshots can be mutated in place.
  const permissionFacts = createMemo(
    () => {
      revision();
      const source = props.page.context().gateway;
      const { hello, selfUser } = source.snapshot;
      return {
        source,
        auth: Boolean(hello?.auth),
        role: hello?.auth?.role,
        scopes: hello?.auth?.scopes?.join("\n"),
        identityType: selfUser?.identity?.type,
        identityId: selfUser?.identity?.id,
        directory: profileDirectory(source).result,
      };
    },
    {
      equals: (a, b) =>
        a.source === b.source &&
        a.auth === b.auth &&
        a.role === b.role &&
        a.scopes === b.scopes &&
        a.identityType === b.identityType &&
        a.identityId === b.identityId &&
        a.directory === b.directory,
    },
  );
  const canPresentCreate = createMemo(() => {
    permissionFacts();
    return props.page.canCreateCron();
  });
  function canPresentJob(job: CronJob): boolean {
    permissionFacts();
    return props.page.canManageJob(job);
  }

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
  const scopeControl = () => (
    <AgentScopeControl
      agents={pageHeader().agents}
      selection={props.page.context().agentSelection}
      selectedId={pageHeader().selectedAgentId}
    />
  );
  const phoneList = () => phoneLayout() && !viewProps().editingJob && !viewProps().createOpen;
  const historyOverview = () =>
    viewProps().listTab === "activity" && !viewProps().editingJob && !viewProps().createOpen;
  return (
    <>
      <HubPageHeader
        active="cron"
        class={historyOverview() ? "cron-header cron-header--history" : "cron-header"}
        title={historyOverview() ? t("cron.list.activityTab") : undefined}
        subtitle={pageHeader().filtered ? t("cron.list.sessionFilter") : undefined}
        docsUrl="https://docs.openclaw.ai/automation/cron-jobs"
        actions={
          <div class="cron-header__actions">
            {!phoneList() && !viewProps().editingJob && !viewProps().createOpen ? (
              <HistoryButton {...viewProps()} />
            ) : undefined}
            {pageHeader().filtered ? (
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
              scopeControl()
            )}
          </div>
        }
      />
      <CronRunTranscriptView transcript={props.page.runTranscript} revision={revision} />
      <SettingsWorkspace>
        <CronView
          {...viewProps()}
          canManageJob={canPresentJob}
          canCreate={canPresentCreate()}
          phoneLayout={phoneList()}
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

function CronPage(props: { routeSearch?: string }) {
  let host!: HTMLElement;
  return (
    <openclaw-cron-page ref={(element) => (host = element)}>
      <CronPageBody routeSearch={props.routeSearch} host={host} />
    </openclaw-cron-page>
  );
}

export function renderSolid(props: SolidRouteProps) {
  return (
    <Loading>
      <CronPage routeSearch={typeof props.data === "string" ? props.data : ""} />
    </Loading>
  );
}
