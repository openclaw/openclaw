import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { AgentScopeControl } from "../../components/agent-scope-control.tsx";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { i18n } from "../../i18n/index.ts";
import { hasCronFormErrors } from "../../lib/cron/index.ts";
import { getCronRunsViewState } from "../../lib/cron/runs.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectI18n, t } from "../../lib/reactive/i18n.ts";
import { CronPageController } from "./cron-page-controller.ts";
import { reserveCronEditorClearance } from "./editor-clearance.ts";
import { validateCronEventSelection } from "./event-source.ts";
import {
  buildCronSuggestions,
  resolveConversationTargetSuggestions,
  THINKING_SUGGESTIONS,
} from "./form-suggestions.ts";
import { CronRunTranscriptView } from "./run-transcript.tsx";
import type { CronProps } from "./view-types.ts";
import { CronView } from "./view.tsx";

export function CronPageContent(props: { controller: CronPageController; revision: () => number }) {
  const translations = projectI18n(i18n);
  const revision = () => {
    translations.revision();
    return props.revision();
  };
  const viewProps = createMemo<CronProps>(() => {
    revision();
    const page = props.controller;
    const channels = page.context.channels.state;
    const suggestions = buildCronSuggestions({
      channels,
      runtimeConfig: page.context.runtimeConfig.state,
      cron: page.cron,
      agentsList: page.agentsList,
      modelSuggestions: page.cronModelSuggestions,
      conversationTargets: resolveConversationTargetSuggestions(
        page.deliveryDirectory.conversations,
        page.cron.cronForm.deliveryAccountId,
      ),
    });
    const canManage = page.canManageCron;
    const eventSource = page.eventSource.view;
    const fieldErrors = {
      ...page.cron.cronFieldErrors,
      ...validateCronEventSelection(page.cron.cronForm, eventSource),
    };
    return {
      ...page.actions,
      loading: page.cron.cronLoading,
      hasLoaded: page.cron.cronJobsSnapshotRevision !== null,
      listError: page.cron.cronJobsError,
      canManage,
      status: page.cron.cronStatus,
      jobs: page.cron.cronJobs,
      jobsLoadingMore: page.cron.cronJobsLoadingMore,
      jobsTotal: page.cron.cronJobsTotal,
      jobsHasMore: page.cron.cronJobsHasMore,
      jobsQuery: page.cron.cronJobsQuery,
      jobsEnabledFilter: page.cron.cronJobsEnabledFilter,
      jobsScheduleKindFilter: page.cron.cronJobsScheduleKindFilter,
      jobsLastStatusFilter: page.cron.cronJobsLastStatusFilter,
      jobsTriggerFilter: page.cron.cronJobsTriggerFilter,
      jobsSortBy: page.cron.cronJobsSortBy,
      jobsSortDir: page.cron.cronJobsSortDir,
      editingJob: page.cron.cronEditingJob,
      createOpen: page.cron.cronCreateOpen,
      listTab: page.listTab,
      detailTab: page.detailTab,
      error:
        page.cron.cronError ??
        page.cron.cronRunsError ??
        page.deliveryDirectory.error ??
        page.modelSuggestionsError,
      busy: page.cron.cronBusy,
      form: page.cron.cronForm,
      heartbeatScratch: canManage ? page.heartbeatScratch : "",
      channels: channels.channelsSnapshot?.channelMeta?.length
        ? channels.channelsSnapshot.channelMeta.map((entry) => entry.id)
        : (channels.channelsSnapshot?.channelOrder ?? []),
      channelLabels: channels.channelsSnapshot?.channelLabels ?? {},
      channelMeta: channels.channelsSnapshot?.channelMeta ?? [],
      runs: page.cron.cronRuns,
      runsState: getCronRunsViewState(page.cron),
      highlightedRunId: page.cron.cronRunsRunId,
      runsHasMore: page.cron.cronRunsHasMore,
      runsLoadingMore: page.cron.cronRunsLoadingMore,
      runsStatuses: page.cron.cronRunsStatuses,
      runsDeliveryStatuses: page.cron.cronRunsDeliveryStatuses,
      runsQuery: page.cron.cronRunsQuery,
      runsSortDir: page.cron.cronRunsSortDir,
      eventSource,
      fieldErrors,
      canSubmit: !hasCronFormErrors(fieldErrors),
      agentSuggestions: suggestions.agentSuggestions,
      modelSuggestions: suggestions.modelSuggestions,
      thinkingSuggestions: THINKING_SUGGESTIONS,
      timezoneSuggestions: suggestions.timezoneSuggestions,
      deliveryToSuggestions: suggestions.deliveryToSuggestions,
      failureAlertToSuggestions: suggestions.failureAlertToSuggestions,
      accountSuggestions: suggestions.accountTargets,
    };
  });
  const header = createMemo(() => {
    revision();
    const controller = props.controller;
    return {
      title: titleForRoute("cron"),
      subtitle: controller.cron.cronSessionFilter
        ? t("cron.list.sessionFilter")
        : subtitleForRoute("cron"),
      filtered: Boolean(controller.cron.cronSessionFilter),
      agents: controller.agentsList?.agents ?? [],
      selectedAgentId: controller.context.agentSelection.state.scopeId,
    };
  });
  createEffect(revision, () => {
    props.controller.afterRender();
    return reserveCronEditorClearance(props.controller.host);
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
              href={pathForRoute("cron", props.controller.context.basePath)}
              onClick={(event: MouseEvent) => {
                if (shouldHandleNavigationClick(event)) {
                  event.preventDefault();
                  props.controller.context.navigate("cron", { search: "" });
                }
              }}
            >
              {t("cron.list.showAll")}
            </a>
          ) : (
            <AgentScopeControl
              agents={header().agents}
              selection={props.controller.context.agentSelection}
              selectedId={header().selectedAgentId}
            />
          )
        }
      />
      <CronRunTranscriptView controller={props.controller.runTranscript} revision={revision} />
      <SettingsWorkspace>
        <CronView {...viewProps()} />
      </SettingsWorkspace>
    </>
  );
}

function CronPageBody(props: { routeSearch?: string; host: HTMLElement }) {
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
  // Activate after the page host is inserted.
  onSettled(() => queueMicrotask(() => controller.activate()));
  onCleanup(() => controller.dispose());
  return <CronPageContent controller={controller} revision={revision} />;
}

export function CronPage(props: { routeSearch?: string }) {
  let host!: HTMLElement;
  return (
    <openclaw-cron-page ref={(element) => (host = element)}>
      <CronPageBody routeSearch={props.routeSearch} host={host} />
    </openclaw-cron-page>
  );
}
