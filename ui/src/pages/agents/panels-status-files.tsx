import { createMemo, For } from "solid-js";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
} from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { renderCronJobsPagination } from "../../components/cron-jobs-pagination.ts";
import {
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import type { AgentContext } from "../../lib/agents/display.ts";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import { resolveChannelExtras as resolveChannelExtrasFromConfig } from "../../lib/channels/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { AgentPanelAction } from "./panel-ui.tsx";
import { renderAgentContextSection } from "./panels-overview.tsx";

function resolveChannelEntries(snapshot: ChannelsStatusSnapshot | null) {
  if (!snapshot) {
    return [];
  }
  const ids = new Set([
    ...(snapshot.channelOrder ?? []),
    ...(snapshot.channelMeta ?? []).map((entry) => entry.id),
    ...Object.keys(snapshot.channelAccounts ?? {}),
  ]);
  return Array.from(ids, (id) => ({
    id,
    label:
      snapshot.channelMeta?.find((entry) => entry.id === id)?.label ||
      (snapshot.channelLabels?.[id] ?? id),
    accounts: snapshot.channelAccounts?.[id] ?? [],
  }));
}

const CHANNEL_EXTRA_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

function summarizeChannelAccounts(accounts: ChannelAccountSnapshot[]) {
  let connected = 0;
  let configured = 0;
  let enabled = 0;
  for (const account of accounts) {
    const probeOk =
      account.probe && typeof account.probe === "object" && "ok" in account.probe
        ? Boolean(account.probe.ok)
        : false;
    const hasRuntimeStatus =
      typeof account.connected === "boolean" || typeof account.running === "boolean";
    // A successful probe proves API reachability, not a live transport. Preserve it only
    // as a fallback for passive channels that do not publish runtime status.
    const isConnected =
      account.connected === true || account.running === true || (!hasRuntimeStatus && probeOk);
    if (isConnected) {
      connected += 1;
    }
    if (account.configured) {
      configured += 1;
    }
    if (account.enabled) {
      enabled += 1;
    }
  }
  return {
    total: accounts.length,
    connected,
    configured,
    enabled,
  };
}

export function AgentChannels(params: {
  context: AgentContext;
  configForm: Record<string, unknown> | null;
  snapshot: ChannelsStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  lastSuccess: number | null;
  onRefresh: () => void;
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  const entries = createMemo(() => resolveChannelEntries(params.snapshot));
  const lastSuccessLabel = createMemo(() =>
    params.lastSuccess ? formatRelativeTimestamp(params.lastSuccess) : t("common.never"),
  );
  return (
    <>
      {renderAgentContextSection(
        params.context,
        t("agents.context.configurationSubtitle"),
        params.onSelectPanel,
      )}
      {params.error ? <div class="callout danger">{params.error}</div> : undefined}
      {!params.snapshot ? (
        <div class="callout info">{t("agents.channels.loadHint")}</div>
      ) : undefined}
      <SettingsSection
        title={t("agents.channels.title")}
        description={
          <>
            {t("agents.channels.subtitle")}{" "}
            {t("agents.channels.lastRefresh", { time: lastSuccessLabel() })}
          </>
        }
        actions={
          <AgentPanelAction
            label={params.loading ? t("common.refreshing") : t("common.refresh")}
            disabled={params.loading}
            onClick={params.onRefresh}
          />
        }
      >
        {entries().length === 0 ? (
          <SettingsEmpty message={t("agents.channels.empty")} />
        ) : (
          entries().map((entry) => {
            const summary = summarizeChannelAccounts(entry.accounts);
            const status = summary.total
              ? t("agents.channels.connectedCount", {
                  connected: String(summary.connected),
                  total: String(summary.total),
                })
              : t("agents.channels.noAccounts");
            const configLabel = summary.configured
              ? t("agents.channels.configuredCount", { count: String(summary.configured) })
              : t("agents.channels.notConfigured");
            const enabled = summary.total
              ? t("agents.channels.enabledCount", { count: String(summary.enabled) })
              : t("common.disabled");
            const extras = resolveChannelExtrasFromConfig({
              configForm: params.configForm,
              channelId: entry.id,
              fields: CHANNEL_EXTRA_FIELDS,
            });
            const metaParts = [
              entry.id,
              configLabel,
              enabled,
              ...extras.map((extra) => `${extra.label}: ${extra.value}`),
            ];
            return (
              <SettingsRow
                title={entry.label}
                description={metaParts.join(" · ")}
                control={
                  <>
                    {summary.configured === 0 ? (
                      <a
                        class="settings-row__value"
                        href="https://docs.openclaw.ai/channels"
                        target="_blank"
                        rel="noopener"
                      >
                        {t("agents.channels.setupGuide")}
                      </a>
                    ) : undefined}
                    <SettingsStatus
                      kind={summary.connected > 0 ? "ok" : summary.total ? "warn" : "muted"}
                      label={status}
                    />
                  </>
                }
              />
            );
          })
        )}
      </SettingsSection>
    </>
  );
}

export function AgentCron(params: {
  basePath: string;
  context: AgentContext;
  jobs: CronJob[];
  jobsTotal: number;
  jobsHasMore: boolean;
  jobsLoadingMore: boolean;
  status: CronStatus | null;
  scopedTotal: number | null;
  scopedNextWakeAtMs: number | null;
  loading: boolean;
  error: string | null;
  canRunNow: boolean;
  onRefresh: () => void;
  onLoadMore: () => void;
  onRunNow: (jobId: string) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  return (
    <>
      {renderAgentContextSection(
        params.context,
        t("agents.context.schedulingSubtitle"),
        params.onSelectPanel,
      )}
      {params.error ? <div class="callout danger">{params.error}</div> : undefined}
      <SettingsSection
        title={t("agents.cronPanel.schedulerTitle")}
        description={t("agents.cronPanel.schedulerSubtitle")}
        actions={
          <AgentPanelAction
            label={params.loading ? t("common.refreshing") : t("common.refresh")}
            disabled={params.loading}
            onClick={params.onRefresh}
          />
        }
      >
        <For
          each={
            [
              [
                t("common.enabled"),
                params.status
                  ? params.status.enabled
                    ? t("common.yes")
                    : t("common.no")
                  : t("common.na"),
              ],
              [t("agents.cronPanel.jobs"), params.scopedTotal ?? t("common.na")],
              [
                t("agents.cronPanel.nextWake"),
                formatNextRun(params.status?.enabled === false ? null : params.scopedNextWakeAtMs),
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
        {params.jobs.length === 0 ? (
          <SettingsEmpty message={t("agents.cronPanel.noJobs")} />
        ) : (
          <>
            <For each={params.jobs} keyed={(job) => job.id}>
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
                          disabled={!params.canRunNow}
                          onClick={() => params.onRunNow(job().id)}
                        />
                      </>
                    }
                  />
                );
              }}
            </For>
            <LitContent
              render={() =>
                renderCronJobsPagination({
                  jobsShown: params.jobs.length,
                  jobsTotal: params.jobsTotal,
                  hasMore: params.jobsHasMore,
                  loading: params.loading,
                  loadingMore: params.jobsLoadingMore,
                  onLoadMore: params.onLoadMore,
                })
              }
            />
          </>
        )}
      </SettingsSection>
    </>
  );
}
