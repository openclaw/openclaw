import { lazy, Loading, Errored, Show } from "solid-js";
import { SidebarAutomations } from "../../components/app-sidebar-automations.tsx";
import { SidebarViewBoundary } from "../../components/sidebar-view-boundary.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { PanelEmptyState } from "../../components/solid/panel-empty-state.tsx";
import { SettingsPage, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { sectionListsItems } from "../../lib/section-navigation.ts";
import { BackRow, ErrorBanner, NoticeBanner } from "./view-controls.tsx";
import { RunsSection } from "./view-runs.tsx";
import type { CronProps } from "./view-types.ts";
import "../../styles/chat/startup-layout.css";
import "../../styles/chat/text.css";
import "../../styles/cron.css";
import "../../components/tooltip.ts";
registerEnglishCatalog(registerCronEnglish);
const DetailView = lazy(() => import("./view-detail.tsx"), { export: "DetailView" });
export function CronView(props: CronProps) {
  const mode = () => (props.editingJob ? "job" : props.createOpen ? "create" : "overview");
  return (
    <>
      {mode() === "overview" && props.activityOpen ? (
        <ActivityView {...props} />
      ) : mode() === "overview" && props.listsJobs ? (
        <>
          <OverviewNotices {...props} />
          <PageAutomations />
        </>
      ) : mode() === "overview" ? (
        // The sidebar lists every automation; the page waits for one to open, or says why the
        // list could not be read.
        <>
          <OverviewNotices {...props} />
          <div class="cron-overview-empty">
            <PanelEmptyState
              icon={<Icon name="automations" />}
              heading={
                props.listError || (props.jobs.length > 0 && sectionListsItems("automations"))
                  ? t("tabs.cron")
                  : t("cron.list.emptyTitle")
              }
              description={props.listError ?? t("cron.list.emptyHint")}
              action={
                props.listError ? (
                  <button type="button" class="btn btn--sm" onClick={() => void props.onRefresh()}>
                    {t("common.retry")}
                  </button>
                ) : (props.canCreate ?? props.canManage) ? (
                  <button
                    type="button"
                    class="btn primary btn--sm"
                    data-test-id="cron-new-task"
                    onClick={() => props.onOpenCreate()}
                  >
                    <Icon name="plus" /> {t("cron.list.newTask")}
                  </button>
                ) : undefined
              }
            />
          </div>
        </>
      ) : (
        <Errored
          fallback={(error, reset) => (
            <div role="alert">
              {formatUiError(error())}
              <button class="btn" onClick={reset}>
                {t("common.retry")}
              </button>
            </div>
          )}
        >
          <Loading fallback={<p role="status">{t("common.loading")}</p>}>
            <DetailView {...props} mode={mode()} />
          </Loading>
        </Errored>
      )}
    </>
  );
}

/** What the page reports with no automation open: the scheduler state and action outcomes. */
function OverviewNotices(props: CronProps) {
  return (
    <>
      <Show when={props.status?.enabled === false}>
        <InlineAlert
          tone="warning"
          data-test-id="cron-scheduler-banner"
          title={t("cron.list.schedulerOff")}
        >
          {t("cron.runNotStarted.stopped")}
        </InlineAlert>
      </Show>
      <ErrorBanner error={props.error} />
      <NoticeBanner notice={props.notice} />
    </>
  );
}

/** Without a sidebar the page lists the automations as the sidebar would. */
function PageAutomations() {
  const app = useApplication();
  return (
    <div class="cron-overview-list">
      <SidebarViewBoundary>
        <SidebarAutomations
          host={{
            basePath: app.basePath,
            activeRouteId: "cron",
            onNavigate: (route, options) => app.navigate(route, options),
          }}
        />
      </SidebarViewBoundary>
    </div>
  );
}

/** Every automation's runs, opened from the sidebar's Run history. */
function ActivityView(props: CronProps) {
  return (
    <section class="cron-page" data-panel-mode="activity">
      <SettingsPage wide>
        <BackRow {...props} />
        <OverviewNotices {...props} />
        <SettingsSection title={t("cron.list.runHistory")}>
          <div class="cron-activity">
            <RunsSection {...props} showJobName />
          </div>
        </SettingsSection>
      </SettingsPage>
    </section>
  );
}
