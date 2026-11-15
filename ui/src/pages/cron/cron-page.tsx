import { createEffect, createMemo, Loading, Show } from "solid-js";
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
import {
  rememberSectionLocation,
  sectionLocation,
  sectionSidebarShown,
} from "../../lib/section-navigation.ts";
import { createCronPage } from "./cron-page-state.ts";
import { resolveCronRouteData } from "./route-model.ts";
import { CronRunTranscriptView } from "./run-transcript.tsx";
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
  // The phone list seats the scope beside its create action; detail views keep it here.
  const phoneList = () => phoneLayout() && !viewProps().editingJob && !viewProps().createOpen;
  // Beside the open sidebar the page is the automation itself, so it drops the section header.
  const sidebarLists = () => !pageHeader().filtered && sectionSidebarShown("automations");
  return (
    <>
      <Show when={!sidebarLists()}>
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
            ) : phoneList() ? undefined : (
              scopeControl()
            )
          }
        />
      </Show>
      <CronRunTranscriptView transcript={props.page.runTranscript} revision={revision} />
      <SettingsWorkspace>
        <CronView
          {...viewProps()}
          sidebarListsJobs={sidebarLists()}
          onClosePanel={() => {
            // Closing the automation leaves Automations on its empty state for this tab.
            viewProps().onClosePanel();
            const context = props.page.context();
            rememberSectionLocation(context.gateway, "automations", null);
            context.replace("cron", { search: "" });
          }}
          canManageJob={canPresentJob}
          canCreate={canPresentCreate()}
          phoneLayout={phoneList()}
          toolbarScope={phoneList() && !pageHeader().filtered ? scopeControl() : undefined}
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
  // While the next route loads its search is unknown, not empty, so nothing acts on it.
  // Effects never compare, and route data republishes the same search, so a memo lets only a
  // real change through; a stale repeat would otherwise re-record an automation just forgotten.
  const routeSearch = createMemo(() => props.routeSearch);
  createEffect(
    () => routeSearch(),
    (search) => {
      if (search === undefined) {
        return;
      }
      const route = resolveCronRouteData(search);
      // Returning to Automations in this tab reopens the automation left open.
      const opened = sectionLocation(context.gateway, "automations");
      if (!search && opened) {
        context.replace(opened.route, opened.options);
        return;
      }
      rememberSectionLocation(
        context.gateway,
        "automations",
        route.jobId
          ? { route: "cron", options: { search: `?job=${encodeURIComponent(route.jobId)}` } }
          : null,
      );
      page.setRouteSearch(search);
      // `?new` is the sidebar's New automation entry.
      if (route.create) {
        page.actions.onOpenCreate();
      } else if (!search && (page.cron().cronEditingJob || page.cron().cronCreateOpen)) {
        // The section's own root, as choosing Automations again opens it, closes the panel.
        page.actions.onClosePanel();
      }
    },
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
      <CronPage routeSearch={typeof props.data === "string" ? props.data : undefined} />
    </Loading>
  );
}
