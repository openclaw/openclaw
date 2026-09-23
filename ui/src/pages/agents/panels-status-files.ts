import { html, nothing } from "lit";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
} from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { renderCronJobsPagination } from "../../components/cron-jobs-pagination.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
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
import { renderAgentContextSection } from "./panels-overview.ts";

type ChannelSummaryEntry = {
  id: string;
  label: string;
  accounts: ChannelAccountSnapshot[];
};

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot, id: string) {
  const meta = snapshot.channelMeta?.find((entry) => entry.id === id);
  if (meta?.label) {
    return meta.label;
  }
  return snapshot.channelLabels?.[id] ?? id;
}

function resolveChannelEntries(snapshot: ChannelsStatusSnapshot | null): ChannelSummaryEntry[] {
  if (!snapshot) {
    return [];
  }
  const ids = new Set<string>();
  for (const id of snapshot.channelOrder ?? []) {
    ids.add(id);
  }
  for (const entry of snapshot.channelMeta ?? []) {
    ids.add(entry.id);
  }
  for (const id of Object.keys(snapshot.channelAccounts ?? {})) {
    ids.add(id);
  }
  const ordered: string[] = [];
  const seed = snapshot.channelOrder?.length ? snapshot.channelOrder : Array.from(ids);
  for (const id of seed) {
    if (!ids.has(id)) {
      continue;
    }
    ordered.push(id);
    ids.delete(id);
  }
  for (const id of ids) {
    ordered.push(id);
  }
  return ordered.map((id) => ({
    id,
    label: resolveChannelLabel(snapshot, id),
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
        ? Boolean((account.probe as { ok?: unknown }).ok)
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

export function renderAgentChannels(params: {
  context: AgentContext;
  configForm: Record<string, unknown> | null;
  snapshot: ChannelsStatusSnapshot | null;
  loading: boolean;
  error: string | null;
  lastSuccess: number | null;
  onRefresh: () => void;
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  const entries = resolveChannelEntries(params.snapshot);
  const lastSuccessLabel = params.lastSuccess
    ? formatRelativeTimestamp(params.lastSuccess)
    : t("common.never");
  return html`
    ${renderAgentContextSection(
      params.context,
      t("agents.context.configurationSubtitle"),
      params.onSelectPanel,
    )}
    ${params.error ? html`<div class="callout danger">${params.error}</div>` : nothing}
    ${
      !params.snapshot
        ? html`<div class="callout info">${t("agents.channels.loadHint")}</div>`
        : nothing
    }
    ${renderSettingsSection(
      {
        title: t("agents.channels.title"),
        description: html`${t("agents.channels.subtitle")}
        ${t("agents.channels.lastRefresh", { time: lastSuccessLabel })}`,
        actions: html`
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        `,
      },
      entries.length === 0
        ? renderSettingsEmpty(t("agents.channels.empty"))
        : entries.map((entry) => {
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
            return renderSettingsRow({
              title: entry.label,
              description: metaParts.join(" · "),
              control: html`
                ${
                  summary.configured === 0
                    ? html`
                        <a
                          class="settings-row__value"
                          href="https://docs.openclaw.ai/channels"
                          target="_blank"
                          rel="noopener"
                          >${t("agents.channels.setupGuide")}</a
                        >
                      `
                    : nothing
                }
                ${renderSettingsStatus({
                  kind: summary.connected > 0 ? "ok" : summary.total ? "warn" : "muted",
                  label: status,
                })}
              `,
            });
          }),
    )}
  `;
}

export function renderAgentCron(params: {
  basePath: string;
  context: AgentContext;
  agentId: string;
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
  return html`
    ${renderAgentContextSection(
      params.context,
      t("agents.context.schedulingSubtitle"),
      params.onSelectPanel,
    )}
    ${params.error ? html`<div class="callout danger">${params.error}</div>` : nothing}
    ${renderSettingsSection(
      {
        title: t("agents.cronPanel.schedulerTitle"),
        description: t("agents.cronPanel.schedulerSubtitle"),
        actions: html`
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        `,
      },
      html`
        ${renderSettingsRow({
          title: t("common.enabled"),
          control: renderSettingsValue(
            params.status
              ? params.status.enabled
                ? t("common.yes")
                : t("common.no")
              : t("common.na"),
          ),
        })}
        ${renderSettingsRow({
          title: t("agents.cronPanel.jobs"),
          control: renderSettingsValue(params.scopedTotal ?? t("common.na")),
        })}
        ${renderSettingsRow({
          title: t("agents.cronPanel.nextWake"),
          control: renderSettingsValue(
            formatNextRun(params.status?.enabled === false ? null : params.scopedNextWakeAtMs),
          ),
        })}
      `,
    )}
    ${renderSettingsSection(
      {
        title: t("agents.cronPanel.agentJobsTitle"),
        description: t("agents.cronPanel.agentJobsSubtitle"),
      },
      params.jobs.length === 0
        ? renderSettingsEmpty(t("agents.cronPanel.noJobs"))
        : html`
            ${params.jobs.map((job) => {
              const metaParts = [
                job.description,
                formatCronSchedule(job),
                job.sessionTarget,
                formatCronState(job),
                formatCronPayload(job),
              ].filter(Boolean);
              return renderSettingsRow({
                title: job.name,
                description: metaParts.join(" · "),
                control: html`
                  ${renderSettingsStatus({
                    kind: job.enabled ? "ok" : "warn",
                    label: job.enabled ? t("common.enabled") : t("common.disabled"),
                  })}
                  <a
                    class="btn btn--sm"
                    href=${`${pathForRoute("cron", params.basePath)}?job=${encodeURIComponent(job.id)}`}
                    aria-label=${t("agents.cronPanel.editJob", { name: job.name })}
                  >
                    ${t("agents.cronPanel.edit")}
                  </a>
                  <button
                    class="btn btn--sm"
                    ?disabled=${!params.canRunNow}
                    @click=${() => params.onRunNow(job.id)}
                  >
                    ${t("agents.cronPanel.runNow")}
                  </button>
                `,
              });
            })}
            ${renderCronJobsPagination({
              jobsShown: params.jobs.length,
              jobsTotal: params.jobsTotal,
              hasMore: params.jobsHasMore,
              loading: params.loading,
              loadingMore: params.jobsLoadingMore,
              onLoadMore: params.onLoadMore,
            })}
          `,
    )}
  `;
}
