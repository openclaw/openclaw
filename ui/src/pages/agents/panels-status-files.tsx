import { createMemo, For } from "solid-js";
import type { ChannelAccountSnapshot, ChannelsStatusSnapshot } from "../../api/types.ts";
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
import { resolveChannelExtras as resolveChannelExtrasFromConfig } from "../../lib/channels/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../../lib/presenter.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentPanelAction } from "./panel-ui.tsx";
import { renderAgentContextSection } from "./panels-overview.tsx";

registerEnglishCatalog(registerSettingsEnglish);

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

export function AgentChannels(
  params: AgentsPageView["channels"] & {
    context: AgentContext;
    configForm: Record<string, unknown> | null;
    readState: AgentsPageView["readChannels"];
    onSelectPanel: (panel: AgentsPanel) => void;
  },
) {
  const entries = createMemo(() => resolveChannelEntries(params.readState().channelsSnapshot));
  const lastSuccessLabel = createMemo(() =>
    params.readState().channelsLastSuccess
      ? formatRelativeTimestamp(params.readState().channelsLastSuccess)
      : t("common.never"),
  );
  return (
    <>
      {renderAgentContextSection(
        params.context,
        t("agents.context.configurationSubtitle"),
        params.onSelectPanel,
      )}
      {params.readState().channelsError ? (
        <div class="callout danger">{params.readState().channelsError}</div>
      ) : undefined}
      {!params.readState().channelsSnapshot ? (
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
            label={
              params.readState().channelsLoading ? t("common.refreshing") : t("common.refresh")
            }
            disabled={params.readState().channelsLoading}
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

export function AgentCron(
  params: AgentsPageView["cron"] & {
    basePath: string;
    context: AgentContext;
    readState: () => CronState;
    canRunNow: boolean;
    onSelectPanel: (panel: AgentsPanel) => void;
  },
) {
  return (
    <>
      {renderAgentContextSection(
        params.context,
        t("agents.context.schedulingSubtitle"),
        params.onSelectPanel,
      )}
      {params.readState().cronError ? (
        <div class="callout danger">{params.readState().cronError}</div>
      ) : undefined}
      <SettingsSection
        title={t("agents.cronPanel.schedulerTitle")}
        description={t("agents.cronPanel.schedulerSubtitle")}
        actions={
          <AgentPanelAction
            label={params.readState().cronLoading ? t("common.refreshing") : t("common.refresh")}
            disabled={params.readState().cronLoading}
            onClick={params.onRefresh}
          />
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
                          disabled={!params.canRunNow}
                          onClick={() => params.onRunNow(job().id)}
                        />
                      </>
                    }
                  />
                );
              }}
            </For>
            <CronJobsPagination
              jobsShown={params.readState().cronJobs.length}
              jobsTotal={params.readState().cronJobsTotal}
              hasMore={params.readState().cronJobsHasMore}
              loading={params.readState().cronLoading}
              loadingMore={params.readState().cronJobsLoadingMore}
              onLoadMore={params.onLoadMore}
            />
          </>
        )}
      </SettingsSection>
    </>
  );
}
