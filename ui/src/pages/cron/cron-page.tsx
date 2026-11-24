import { createEffect, createMemo, Loading, Show } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import { isNativeEmbedHost } from "../../app/native-web-chrome.ts";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { AutomationsFilter } from "../../components/app-sidebar-automations-filter.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { i18nRevision } from "../../lib/reactive/i18n.ts";
import { rememberSectionLocation, sectionLocation } from "../../lib/section-navigation.ts";
import { createCronPage } from "./cron-page-state.ts";
import { resolveCronRouteData } from "./route-model.ts";
import { buildCronViewProps } from "./view-props.ts";
import { CronView } from "./view.tsx";

export function CronPageContent(props: { page: ReturnType<typeof createCronPage> }) {
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
      agents: page.inventories.agents.read().agentsList?.agents ?? [],
      selectedAgentId: page.context().agentSelection.state.scopeId,
    };
  };
  // The Automations sidebar lists every automation, beside the page, in the collapsed rail's peek
  // or in the phone drawer; there the page is the automation itself, without the section header.
  // The native embed shows no sidebar, so the page lists the automations under its header.
  const listsJobs = isNativeEmbedHost();
  return (
    <>
      <Show when={listsJobs}>
        <HubPageHeader
          active="cron"
          docsUrl="https://docs.openclaw.ai/automation/cron-jobs"
          actions={
            <>
              <AgentScopeControl
                agents={pageHeader().agents}
                selection={props.page.context().agentSelection}
                selectedId={pageHeader().selectedAgentId}
              />
              <AutomationsFilter />
            </>
          }
        />
      </Show>
      <SettingsWorkspace>
        <CronView
          {...viewProps()}
          listsJobs={listsJobs}
          onClosePanel={() => {
            // Closing the automation leaves Automations on its empty state for this tab.
            viewProps().onClosePanel();
            const context = props.page.context();
            rememberSectionLocation(context.gateway, "automations", null);
            context.replace("cron", { search: "" });
          }}
          canManageJob={canPresentJob}
          canCreate={canPresentCreate()}
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
  // Route changes retarget Gateway job queries.
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
          : route.activity
            ? { route: "cron", options: { search: "?activity" } }
            : null,
      );
      page.setRouteSearch(search);
      // `?new` is the sidebar's New automation entry.
      if (route.create) {
        page.actions.onOpenCreate();
      } else if (
        (!search || route.activity) &&
        (page.cron().cronEditingJob || page.cron().cronCreateOpen)
      ) {
        // The section's own root, as choosing Automations again opens it, and its Activity close
        // the panel.
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
