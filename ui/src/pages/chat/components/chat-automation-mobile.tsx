import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { isSystemMonitorDeclaration } from "../../../../../src/cron/system-owned-declaration.js";
import type { CronDeliveryStatus, CronJob, CronRunLogEntry } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { HubTabs } from "../../../components/solid/hub-tabs.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { SanitizedHtml } from "../../../components/solid/sanitized-html.tsx";
import { registerCronEnglish } from "../../../i18n/locales/en-cron.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import { createMsFormatter } from "../../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { CronRunTranscriptView, type createCronRunTranscript } from "../../cron/run-transcript.tsx";
import { DisabledNote } from "../../cron/view-job-status.tsx";
import { runStatusLabel } from "../../cron/view-runs.tsx";
import type { CronProps } from "../../cron/view-types.ts";
import type { SessionAutomationInventory } from "./chat-summary-automations.tsx";
import { sessionAutomationSchedule } from "./session-automation-schedule.ts";
import "../../../styles/chat/automation-mobile.css";
import "../../../styles/chat/summary-automations.css";

registerEnglishCatalog(registerCronEnglish);

export type SessionAutomationMobileHistoryProps = Pick<
  CronProps,
  | "runs"
  | "runsState"
  | "runsHasMore"
  | "runsLoadingMore"
  | "runsStatuses"
  | "runsDeliveryStatuses"
  | "runsQuery"
  | "runsSortDir"
  | "runsSortBy"
  | "onLoadMoreRuns"
  | "onRunsFiltersChange"
  | "onRefresh"
  | "highlightedRunId"
> & {
  onViewRunTranscript: NonNullable<CronProps["onViewRunTranscript"]>;
};

export type SessionAutomationMobileBodyProps = {
  /** Full definition from the native cron selection owner, never a compact inventory row. */
  job: CronJob;
  tab: "overview" | "history";
  onTabChange: (tab: "overview" | "history") => void;
  history: SessionAutomationMobileHistoryProps;
  canManage: boolean;
  connected: boolean;
  heartbeatScratch: string;
  basePath: string;
  onOpenEditor: (jobId: string) => void;
};

/** The mobile host owns Back, title and scrollport. This body owns no route or query. */
export function SessionAutomationMobileBody(props: SessionAutomationMobileBodyProps) {
  return (
    <div class="session-automation-mobile">
      <HubTabs<"overview" | "history">
        id={`session-automation-${props.job.id}`}
        panelId={`session-automation-${props.job.id}-panel`}
        active={props.tab}
        tabs={[
          { value: "overview", label: t("chat.sessionAutomation.overview") },
          { value: "history", label: t("chat.sessionAutomation.history") },
        ]}
        ariaLabel={t("cron.detail.tabsLabel")}
        carapace
        onSelect={(tab) => props.onTabChange(tab)}
      />
      <div
        id={`session-automation-${props.job.id}-panel`}
        role="tabpanel"
        aria-labelledby={`session-automation-${props.job.id}-tab-${props.tab}`}
      >
        {props.tab === "overview" ? (
          <AutomationOverview {...props} />
        ) : (
          <AutomationHistory job={props.job} history={props.history} />
        )}
      </div>
    </div>
  );
}

export function SessionAutomationMobileHeading(props: {
  job: Pick<CronJob, "id" | "name" | "displayName">;
}) {
  return (
    <div class="session-automation-mobile-heading">
      <span>{t("chat.sessionAutomation.title")}</span>
      <strong>{props.job.displayName || props.job.name || props.job.id}</strong>
    </div>
  );
}

function Group(props: { title?: string; children: JSX.Element }) {
  return (
    <section class="session-automation-mobile__section">
      {props.title && <h3>{props.title}</h3>}
      <div class="session-automation-mobile__group">{props.children}</div>
    </section>
  );
}
function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="session-automation-mobile__fact">
      <span>{props.label}</span>
      <span>{props.children}</span>
    </div>
  );
}
function AutomationOverview(props: SessionAutomationMobileBodyProps) {
  const schedule = createMemo(() => sessionAutomationSchedule(props.job.schedule));
  const systemOwned = () => isSystemMonitorDeclaration(props.job.declarationKey);
  const editable = () => props.canManage && !systemOwned();
  const payload = () => props.job.payload;
  const task = createMemo(() => {
    const value = payload();
    switch (value.kind) {
      case "agentTurn":
        return value.message;
      case "systemEvent":
        return value.text;
      case "script":
        return value.script;
      case "command":
        return value.argv.join("\n");
      case "heartbeat":
        return props.heartbeatScratch;
    }
    return undefined;
  });
  const delivery = () => props.job.delivery;
  const agentPayload = () => {
    const value = payload();
    return value.kind === "agentTurn" ? value : undefined;
  };
  const running = () => props.connected && props.job.state.runningAtMs !== undefined;
  const target = () =>
    props.job.sessionTarget === "main"
      ? t("cron.form.mainSession")
      : props.job.sessionTarget === "isolated"
        ? t("cron.form.isolatedSession")
        : props.job.sessionTarget;
  return (
    <>
      <Group>
        <Fact label={t("cron.runs.status")}>
          {props.job.state.autoDisabled || !props.job.enabled ? (
            <DisabledNote job={props.job} />
          ) : running() ? (
            t("common.running")
          ) : (
            t("cron.detail.active")
          )}
        </Fact>
        {systemOwned() && (
          <p class="session-automation-mobile__note">{t("chat.sessionAutomation.managed")}</p>
        )}
        {props.job.state.autoDisabled && props.job.state.lastError && (
          <p class="session-automation-mobile__note">
            {formatUiExternalText(props.job.state.lastError)}
          </p>
        )}
      </Group>
      <Group
        title={t(
          payload().kind === "heartbeat"
            ? "chat.sessionAutomation.heartbeat"
            : "chat.sessionAutomation.task",
        )}
      >
        {payload().kind === "script" || payload().kind === "command" ? (
          <pre class="session-automation-mobile__task">{task()}</pre>
        ) : (
          <p class="session-automation-mobile__task">{task() || t("common.na")}</p>
        )}
      </Group>
      <Group title={t("cron.detail.scheduleSection")}>
        <Fact label={t("chat.sessionAutomation.runs")}>{schedule()}</Fact>
        <Show when={props.job.schedule.kind === "cron" ? props.job.schedule : undefined}>
          {(cron) => (
            <Fact label={t("cron.form.timezoneOptional")}>
              {cron().tz || t("chat.sessionAutomation.gatewayTimezone")}
            </Fact>
          )}
        </Show>
        {props.job.trigger && (
          <Fact label={t("cron.form.conditionTrigger")}>{t("cron.form.triggerConfigured")}</Fact>
        )}
      </Group>
      <Group title={t("chat.sessionAutomation.execution")}>
        <Fact label={t("cron.form.action")}>
          {t(
            payload().kind === "heartbeat"
              ? "chat.sessionAutomation.heartbeat"
              : `cron.form.${payload().kind}`,
          )}
        </Fact>
        <Fact label={t("cron.form.agentId")}>
          {props.job.agentId || t("chat.sessionAutomation.defaultValue")}
        </Fact>
        <Fact label={t("cron.form.runsIn")}>{target()}</Fact>
        <Show when={agentPayload()}>
          {(agent) => (
            <>
              <Fact label={t("cron.form.model")}>
                {agent().model || t("chat.sessionAutomation.defaultValue")}
              </Fact>
              <Fact label={t("cron.form.thinking")}>
                {agent().thinking || t("chat.sessionAutomation.defaultValue")}
              </Fact>
            </>
          )}
        </Show>
      </Group>
      <Group title={t("cron.detail.deliverySection")}>
        <Fact label={t("cron.form.deliveryModeLabel")}>
          {t(
            delivery()?.mode === "announce"
              ? "cron.form.announceDefault"
              : delivery()?.mode === "webhook"
                ? "cron.form.webhookPost"
                : "cron.form.noneInternal",
          )}
        </Fact>
        {delivery()?.channel && <Fact label={t("cron.form.channel")}>{delivery()?.channel}</Fact>}
        {delivery()?.to && (
          <Fact label={t(delivery()?.mode === "webhook" ? "cron.form.webhookUrl" : "cron.form.to")}>
            {delivery()?.to}
          </Fact>
        )}
        {delivery()?.accountId && (
          <Fact label={t("cron.form.accountId")}>{delivery()?.accountId}</Fact>
        )}
      </Group>
      {props.job.description && (
        <Group title={t("cron.form.description")}>
          <p class="session-automation-mobile__task">{props.job.description}</p>
        </Group>
      )}
      <Group>
        <a
          class="session-automation-mobile__editor"
          href={`${pathForRoute("cron", props.basePath)}?${new URLSearchParams({ job: props.job.id })}`}
          onClick={(event) => {
            if (shouldHandleNavigationClick(event)) {
              event.preventDefault();
              props.onOpenEditor(props.job.id);
            }
          }}
        >
          <Icon name={editable() ? "pencil" : "clock"} />
          <span>
            {t(editable() ? "chat.sessionAutomation.edit" : "chat.sessionAutomation.open")}
          </span>
          <Icon name="chevronRight" />
        </a>
      </Group>
    </>
  );
}

const deliveryOptions: Array<[CronDeliveryStatus, string]> = [
  ["delivered", "cron.runs.deliveryDelivered"],
  ["not-delivered", "cron.runs.deliveryNotDelivered"],
  ["unknown", "cron.runs.deliveryUnknown"],
  ["not-requested", "cron.runs.deliveryNotRequested"],
];

function AutomationHistory(props: { job: CronJob; history: SessionAutomationMobileHistoryProps }) {
  const history = () => props.history;
  const timestamp = createMemo(() => createMsFormatter(undefined, t("common.na")));
  const filtered = () =>
    Boolean(
      history().highlightedRunId ||
      history().runsQuery.trim() ||
      history().runsStatuses.length ||
      history().runsDeliveryStatuses.length,
    );
  return (
    <div aria-busy={history().runsState === "pending" ? "true" : "false"}>
      {props.job.trigger && (
        <Group title={t("cron.runs.conditionActivity")}>
          <Fact label={t("cron.runs.checks")}>{props.job.state.triggerEvalCount ?? 0}</Fact>
          <Fact label={t("cron.runs.lastChecked")}>
            {props.job.state.lastTriggerEvalAtMs === undefined
              ? t("cron.runs.notChecked")
              : timestamp()(props.job.state.lastTriggerEvalAtMs)}
          </Fact>
          <Fact label={t("cron.runs.lastFired")}>
            {props.job.state.lastTriggerFireAtMs === undefined
              ? t("cron.runs.neverFired")
              : timestamp()(props.job.state.lastTriggerFireAtMs)}
          </Fact>
        </Group>
      )}
      {history().highlightedRunId && (
        <p>
          {t("cron.linkedRun.label")}{" "}
          <button
            type="button"
            onClick={() => void history().onRunsFiltersChange({ cronRunsRunId: null })}
          >
            {t("cron.linkedRun.showAll")}
          </button>
        </p>
      )}
      <div class="session-automation-mobile__filters">
        <label class="session-automation-mobile__filter">
          <span class="sr-only">{t("cron.runs.searchRuns")}</span>
          <input
            type="search"
            value={history().runsQuery}
            placeholder={t("cron.runs.searchPlaceholder")}
            onInput={(event) =>
              void history().onRunsFiltersChange({ cronRunsQuery: event.currentTarget.value })
            }
          />
        </label>
        <label class="session-automation-mobile__filter">
          <span class="sr-only">{t("chat.sessionAutomation.order")}</span>
          <select
            aria-label={t("chat.sessionAutomation.order")}
            value={history().runsSortBy === "status" ? "status" : history().runsSortDir}
            onChange={(event) => {
              const order = event.currentTarget.value;
              if (order === "asc" || order === "desc" || order === "status") {
                void history().onRunsFiltersChange({
                  cronRunsSortBy: order === "status" ? "status" : "time",
                  cronRunsSortDir: order === "asc" ? "asc" : "desc",
                  cronRunsStatuses: [],
                  cronRunsDeliveryStatuses: [],
                });
              }
            }}
          >
            <option value="desc">{t("cron.runs.newestFirst")}</option>
            <option value="asc">{t("cron.runs.oldestFirst")}</option>
            <option value="status">{t("cron.runs.status")}</option>
          </select>
        </label>
      </div>
      {history().runsState === "failed" && (
        <div
          class={[
            "session-automation-mobile__message",
            { "session-automation-mobile__empty": history().runs.length === 0 },
          ]}
          role="alert"
        >
          <span>{t("chat.sessionAutomation.historyError")}</span>
          <button type="button" onClick={() => history().onRefresh()}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {history().runsState === "pending" && (
        <p role="status" class="session-automation-mobile__empty">
          {t("common.loading")}
        </p>
      )}
      {history().runsState === "ready" && history().runs.length === 0 && (
        <div class="session-automation-mobile__empty">
          <Icon name="clock" />
          <strong>
            {t(
              filtered()
                ? "cron.runs.noMatching"
                : props.job.trigger
                  ? "cron.runs.emptyConditionTitle"
                  : "cron.runs.emptyTitle",
            )}
          </strong>
          {!filtered() && (
            <p>
              {t(props.job.trigger ? "cron.runs.conditionActivityHint" : "cron.runs.emptyHint")}
            </p>
          )}
        </div>
      )}
      <div class="session-automation-mobile__group">
        <For
          each={history().runs}
          keyed={(entry) => `${entry.jobId}:${entry.runId ?? entry.runAtMs ?? entry.ts}`}
        >
          {(entry) => (
            <AutomationRun
              entry={entry()}
              timestamp={timestamp()}
              onViewTranscript={(run, trigger) => history().onViewRunTranscript(run, trigger)}
            />
          )}
        </For>
      </div>
      {history().runsHasMore && (
        <button
          class="session-automation-mobile__more"
          type="button"
          disabled={history().runsLoadingMore || history().runsState === "pending"}
          onClick={() => history().onLoadMoreRuns()}
        >
          {t("cron.runs.loadMore")}
        </button>
      )}
    </div>
  );
}
function AutomationRun(props: {
  entry: CronRunLogEntry;
  timestamp: ReturnType<typeof createMsFormatter>;
  onViewTranscript: NonNullable<CronProps["onViewRunTranscript"]>;
}) {
  const delivery = () =>
    t(
      deliveryOptions.find(
        ([value]) => value === (props.entry.deliveryStatus ?? "not-requested"),
      )?.[1] ?? "cron.runs.deliveryUnknown",
    );
  return (
    <details class="session-automation-mobile__run">
      <summary>
        <span>
          <strong>{props.timestamp(props.entry.runAtMs ?? props.entry.ts)}</strong>
          <small>
            {runStatusLabel(props.entry.status ?? "unknown", props.entry.completionStatus)}
            {props.entry.durationMs !== undefined
              ? ` · ${formatDurationCompact(props.entry.durationMs) ?? t("common.na")}`
              : ""}
          </small>
        </span>
        <Icon name="chevronDown" />
      </summary>
      <div class="session-automation-mobile__run-body">
        <SanitizedHtml
          tag="div"
          class="chat-text"
          html={toSanitizedMarkdownHtml(
            props.entry.summary ||
              formatUiExternalText(props.entry.error) ||
              t("cron.runEntry.noSummary"),
          )}
        />
        <p class="session-automation-mobile__note">{delivery()}</p>
        {props.entry.summary && props.entry.error && (
          <p class="session-automation-mobile__note">{formatUiExternalText(props.entry.error)}</p>
        )}
        {props.entry.deliveryError && (
          <p class="session-automation-mobile__note">
            {formatUiExternalText(props.entry.deliveryError)}
          </p>
        )}
        {props.entry.deliverySuppressionReason && (
          <p class="session-automation-mobile__note">
            {t("cron.runEntry.deliverySuppression", {
              reason: formatUiExternalText(props.entry.deliverySuppressionReason),
            })}
          </p>
        )}
        {(props.entry.model || props.entry.provider) && (
          <p class="session-automation-mobile__note">
            {[props.entry.model, props.entry.provider].filter(Boolean).join(" · ")}
          </p>
        )}
        {props.entry.usage?.total_tokens !== undefined && (
          <p class="session-automation-mobile__note">
            {props.entry.usage.total_tokens} {t("usage.metrics.tokens")}
          </p>
        )}
        {props.entry.nextRunAtMs !== undefined && (
          <p class="session-automation-mobile__note">
            {t("cron.jobState.next")} {props.timestamp(props.entry.nextRunAtMs)}
          </p>
        )}
        {(props.entry.runId || props.entry.runAtMs !== undefined || props.entry.sessionKey) && (
          <button
            type="button"
            onClick={(event) => props.onViewTranscript(props.entry, event.currentTarget)}
          >
            {t("cron.runEntry.viewTranscript")}
          </button>
        )}
      </div>
    </details>
  );
}

export function SessionAutomationMobileTranscript(props: {
  transcript: ReturnType<typeof createCronRunTranscript>;
  revision: () => number;
}) {
  return (
    <div class="session-automation-mobile-transcript">
      <CronRunTranscriptView {...props} />
    </div>
  );
}

export type SessionAutomationMobileListProps = {
  inventory: SessionAutomationInventory;
  basePath: string;
  onOpenAutomation: (jobId: string) => void;
};
export function SessionAutomationMobileList(props: SessionAutomationMobileListProps) {
  const inventory = () => props.inventory;
  return (
    <div class="session-automation-mobile" aria-busy={inventory().loading() ? "true" : "false"}>
      {!inventory().connected() && (
        <p role="status" class="session-automation-mobile__note">
          {t("chat.sessionDetails.automationOffline")}
        </p>
      )}
      {inventory().error() && (
        <div
          class={[
            "session-automation-mobile__message",
            { "session-automation-mobile__empty": inventory().jobs().length === 0 },
          ]}
          role="alert"
        >
          <span>
            {t(
              inventory().loaded()
                ? "chat.sessionDetails.automationUpdateError"
                : "chat.sessionDetails.automationError",
            )}
          </span>
          <button
            type="button"
            disabled={inventory().loading() || !inventory().connected()}
            onClick={() => void inventory().refresh()}
          >
            {t("common.retry")}
          </button>
        </div>
      )}
      {!inventory().available() && (
        <p role="status" class="session-automation-mobile__empty">
          {t("chat.sessionDetails.automationUnavailable")}
        </p>
      )}
      {!inventory().loaded() && inventory().loading() && (
        <p role="status" class="session-automation-mobile__empty">
          {t("chat.sessionDetails.automationLoading")}
        </p>
      )}
      {inventory().loaded() &&
        !inventory().error() &&
        !inventory().loading() &&
        inventory().total() === 0 && (
          <div class="session-automation-mobile__empty">
            <Icon name="clock" />
            <strong>{t("chat.sessionDetails.automationEmpty")}</strong>
            <p>{t("chat.sessionAutomation.emptyHint")}</p>
          </div>
        )}
      <div class="session-automation-mobile__group">
        <For each={inventory().jobs()} keyed={(job) => job.id}>
          {(job) => {
            const schedule = createMemo(() => {
              const value = job().schedule;
              return value ? sessionAutomationSchedule(value) : "";
            });
            return (
              <a
                class="session-automation-mobile__list-row"
                href={`${pathForRoute("cron", props.basePath)}?${new URLSearchParams({ job: job().id })}`}
                onClick={(event) => {
                  if (shouldHandleNavigationClick(event)) {
                    event.preventDefault();
                    props.onOpenAutomation(job().id);
                  }
                }}
              >
                <span class="session-automation-mobile__list-icon">
                  <Icon name="clock" />
                  {job().autoDisabled ? (
                    <span class="chat-summary__automation-attention" />
                  ) : !job().enabled ? (
                    <span class="chat-summary__automation-paused">
                      <Icon name="pause" />
                    </span>
                  ) : undefined}
                </span>
                <span class="session-automation-mobile__list-copy">
                  <strong>{job().name || job().id}</strong>
                  <small>
                    {job().autoDisabled
                      ? t("chat.sessionDetails.automationAttention")
                      : !job().enabled
                        ? t("chat.sessionDetails.automationPaused")
                        : inventory().connected() && job().runningAtMs !== undefined
                          ? t("common.running")
                          : schedule()}
                  </small>
                </span>
                <Icon name="chevronRight" />
              </a>
            );
          }}
        </For>
      </div>
      {inventory().hasMore() && (
        <button
          type="button"
          class="session-automation-mobile__more"
          disabled={inventory().loading() || inventory().error() || !inventory().connected()}
          onClick={() => void inventory().loadMore()}
        >
          {t("chat.sessionDetails.automationMore")}
        </button>
      )}
    </div>
  );
}
