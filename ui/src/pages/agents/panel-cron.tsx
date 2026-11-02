import type { JSX } from "@solidjs/web";
import {
  action,
  createMemo,
  createOptimistic,
  Errored,
  For,
  isPending,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { CronJobsPagination } from "../../components/cron-jobs-pagination.tsx";
import {
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import type { AgentContext } from "../../lib/agents/display.ts";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../../lib/presenter.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { AgentCronRead } from "./agent-cron-presenter.ts";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentPanelAction } from "./panel-ui.tsx";
import { renderAgentContextSection } from "./panels-overview.tsx";

registerEnglishCatalog(registerSettingsEnglish);

/** Only transient notices and controls live here; cached rows keep their DOM lifetime. */
function CronReadBoundary(props: {
  read: AgentCronRead | null;
  reportError?: boolean;
  errorRole?: "alert";
  children: (pending: boolean, message?: string) => JSX.Element;
}) {
  return (
    <Show when={props.read} keyed fallback={props.children(false)}>
      {(receipt) => {
        const complete = createMemo(() => receipt.completion.then((message) => ({ message })));
        return (
          <Errored
            fallback={(error) =>
              props.reportError ? (
                <div class="callout danger" role={props.errorRole}>
                  {formatUiError(error())}
                </div>
              ) : (
                props.children(false)
              )
            }
          >
            <Loading fallback={props.children(true)}>
              {props.children(
                isPending(() => complete()),
                complete().message ?? undefined,
              )}
            </Loading>
          </Errored>
        );
      }}
    </Show>
  );
}

export function AgentCron(
  params: AgentsPageView["cron"] & {
    basePath: string;
    context: AgentContext;
    readState: () => CronState;
    canRunNow: boolean;
    onSelectPanel: (panel: AgentsPanel) => void;
  },
) {
  const [running, setRunning] = createOptimistic<CronState | null>(null);
  const run = action(function* (receipt: AgentCronRead) {
    setRunning(receipt.scope);
    yield receipt.completion;
  });
  const onRunNow = (jobId: string) => {
    const receipt = params.onRunNow(jobId);
    if (receipt) {
      onSettled(() => void run(receipt).catch(() => {}));
    }
  };
  return (
    <>
      {renderAgentContextSection(
        params.context,
        t("agents.context.schedulingSubtitle"),
        params.onSelectPanel,
      )}
      <CronReadBoundary read={params.read().summary} reportError>
        {() => undefined}
      </CronReadBoundary>
      <CronReadBoundary read={params.read().command} reportError>
        {(_pending, message) => (message ? <div class="callout danger">{message}</div> : undefined)}
      </CronReadBoundary>
      <Show when={params.read().command && params.readState().cronNotice}>
        {(notice) => (
          <div class="callout" role="status">
            {notice()}
          </div>
        )}
      </Show>
      <SettingsSection
        title={t("agents.cronPanel.schedulerTitle")}
        description={t("agents.cronPanel.schedulerSubtitle")}
        actions={
          <CronReadBoundary read={params.read().refresh}>
            {(pending) => (
              <AgentPanelAction
                label={pending ? t("common.refreshing") : t("common.refresh")}
                disabled={pending}
                onClick={params.onRefresh}
              />
            )}
          </CronReadBoundary>
        }
      >
        <For
          each={
            [
              [
                t("common.enabled"),
                params.readState().cronStatus
                  ? params.readState().cronStatus?.enabled
                    ? t("common.yes")
                    : t("common.no")
                  : t("common.na"),
              ],
              [t("agents.cronPanel.jobs"), params.readState().cronScopedTotal ?? t("common.na")],
              [
                t("agents.cronPanel.nextWake"),
                formatNextRun(
                  params.readState().cronStatus?.enabled === false
                    ? null
                    : params.readState().cronScopedNextWakeAtMs,
                ),
              ],
            ] as const
          }
        >
          {([title, value]) => (
            <SettingsRow title={title} control={<SettingsValue value={value} />} />
          )}
        </For>
      </SettingsSection>
      <SettingsSection
        title={t("agents.cronPanel.agentJobsTitle")}
        description={t("agents.cronPanel.agentJobsSubtitle")}
      >
        <CronReadBoundary read={params.read().jobs} reportError errorRole="alert">
          {() => undefined}
        </CronReadBoundary>
        {params.readState().cronJobs.length === 0 ? (
          <SettingsEmpty message={t("agents.cronPanel.noJobs")} />
        ) : (
          <>
            <For each={params.readState().cronJobs} keyed={(job) => job.id}>
              {(job) => {
                const description = createMemo(() =>
                  [
                    job().description,
                    formatCronSchedule(job()),
                    job().sessionTarget,
                    formatCronState(job()),
                    formatCronPayload(job()),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                );
                return (
                  <SettingsRow
                    title={job().name}
                    description={description()}
                    control={
                      <>
                        <SettingsStatus
                          kind={job().enabled ? "ok" : "warn"}
                          label={job().enabled ? t("common.enabled") : t("common.disabled")}
                        />
                        <a
                          class="btn btn--sm"
                          href={`${pathForRoute("cron", params.basePath)}?job=${encodeURIComponent(job().id)}`}
                          aria-label={t("agents.cronPanel.editJob", { name: job().name })}
                        >
                          {t("agents.cronPanel.edit")}
                        </a>
                        <AgentPanelAction
                          label={t("agents.cronPanel.runNow")}
                          disabled={!params.canRunNow || running() === params.readState()}
                          onClick={() => onRunNow(job().id)}
                        />
                      </>
                    }
                  />
                );
              }}
            </For>
            <CronReadBoundary read={params.read().jobs}>
              {(pending) => (
                <CronJobsPagination
                  jobsShown={params.readState().cronJobs.length}
                  jobsTotal={params.readState().cronJobsTotal}
                  hasMore={params.readState().cronJobsHasMore}
                  loading={pending && !params.read().jobs?.append}
                  loadingMore={pending && params.read().jobs?.append === true}
                  onLoadMore={params.onLoadMore}
                />
              )}
            </CronReadBoundary>
          </>
        )}
      </SettingsSection>
    </>
  );
}
