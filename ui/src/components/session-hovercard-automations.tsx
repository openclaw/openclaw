import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import type { CronJob } from "../api/types.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isCronJobRunning, resolveCronJobLastRunStatus } from "../lib/cron-status.ts";
import { loadCronJobsPage } from "../lib/cron/jobs.ts";
import { createInitialCronState } from "../lib/cron/state.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { createGatewayConnectionLifecycle } from "../lib/gateway-connection-lifecycle.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { formatCronPayload, formatCronSchedule } from "../lib/presenter.ts";
import { i18nRevision, t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";

export type SessionHovercardAutomation = {
  gateway: ApplicationGateway | null;
  sessionKey: string;
  agentId: string;
  href: string;
  navigate: (jobId?: string) => void;
};

function instructions(job: CronJob): string {
  switch (job.payload.kind) {
    case "agentTurn":
      return job.payload.message;
    case "systemEvent":
      return job.payload.text;
    case "command":
      return job.payload.argv.join(" ");
    case "script":
      return job.payload.script;
    default:
      return formatCronPayload(job);
  }
}

export function SessionHovercardAutomations(props: { automation: SessionHovercardAutomation }) {
  const [revision, publish] = createSignal(0);
  const [selectedId, select] = createSignal<string>();
  let current = createInitialCronState();
  const state = () => {
    revision();
    return current;
  };
  const selected = createMemo(
    () => state().cronJobs.find((job) => job.id === selectedId()) ?? state().cronJobs[0],
  );
  let active = true;
  onCleanup(() => {
    active = false;
  });

  async function load(append = false) {
    const scope = current;
    const pending = loadCronJobsPage(scope, { append });
    publish((value) => value + 1);
    await pending;
    if (active && current === scope) {
      publish((value) => value + 1);
    }
  }

  createEffect(
    () =>
      [props.automation.gateway, props.automation.sessionKey, props.automation.agentId] as const,
    ([gateway, sessionKey, agentId]) => {
      const reset = () => {
        const next = createInitialCronState({
          client: gateway?.snapshot.client ?? null,
          connected: gateway?.snapshot.phase === "connected",
        });
        next.cronSessionFilter = { sessionKey, sessionAgentId: agentId };
        next.cronJobsLimit = 20;
        next.cronJobsSortBy = "name";
        next.canRefresh = () => active && current === next;
        current = next;
        publish((value) => value + 1);
      };
      reset();
      if (!gateway) {
        return undefined;
      }
      const lifecycle = createGatewayConnectionLifecycle(gateway.snapshot);
      const stopConnection = gateway.subscribe((snapshot) => {
        if (lifecycle.transition(snapshot)) {
          reset();
          void load();
        }
      });
      const stopEvents = gateway.subscribeEvents((event) => {
        if (event.event === "cron") {
          void load();
        }
      });
      void load();
      return () => {
        stopConnection();
        stopEvents();
        lifecycle.dispose();
      };
    },
  );

  const rowLabel = () =>
    state().cronJobsTotal === 1 && selected()
      ? selected()!.name.trim() || selected()!.id
      : state().cronJobsSnapshotRevision !== null && state().cronJobsTotal > 0
        ? t("sessionHovercard.automationCount", { count: String(state().cronJobsTotal) })
        : t("sessionsView.automationAttached");
  const status = (job: CronJob) =>
    job.state.autoDisabled
      ? t("chat.sessionDetails.automationAttention")
      : isCronJobRunning(job)
        ? t("common.running")
        : !job.enabled
          ? t("chat.sessionDetails.automationPaused")
          : t("chat.sessionDetails.automationEnabled");
  const loading = () => state().cronLoading || state().cronJobsLoadingMore;
  const message = createMemo(() =>
    !state().connected
      ? t("chat.sessionDetails.automationUnavailable")
      : state().cronJobsError
        ? t("chat.sessionDetails.automationError")
        : !state().cronJobsSnapshotRevision
          ? t("chat.sessionDetails.automationLoading")
          : state().cronJobsTotal === 0
            ? t("chat.sessionDetails.automationEmpty")
            : undefined,
  );
  const schedule = (job: CronJob) => {
    i18nRevision();
    return formatCronSchedule(job);
  };
  const jobHref = (jobId?: string) => {
    const url = new URL(props.automation.href, globalThis.location.origin);
    if (jobId) {
      url.searchParams.set("job", jobId);
    }
    return url.pathname + url.search;
  };
  const OpenLink = (link: { job?: CronJob }) => (
    <a
      class="session-hovercard__automation-open"
      href={link.job ? jobHref(link.job.id) : props.automation.href}
      onClick={(event) => {
        if (shouldHandleNavigationClick(event)) {
          event.preventDefault();
          const job = link.job;
          if (job) {
            props.automation.navigate(job.id);
          } else {
            props.automation.navigate();
          }
        }
      }}
    >
      {t(link.job ? "sessionHovercard.openAutomation" : "sessionHovercard.openAutomations")}
      <Icon name="externalLink" />
    </a>
  );
  return (
    <openclaw-tooltip
      class="session-hovercard__automation-tooltip"
      prop:describe={false}
      placement="right-start"
      open-on-click
    >
      <a
        class="session-hovercard__context-row session-hovercard__automation-link"
        href={props.automation.href}
        onClick={(event) => {
          if (shouldHandleNavigationClick(event)) {
            event.preventDefault();
          }
        }}
      >
        <span class="session-hovercard__context-icon" aria-hidden="true">
          <Icon name="clock" />
        </span>
        <span class="session-hovercard__context-value session-hovercard__context-text">
          {rowLabel()}
        </span>
        <span class="session-hovercard__context-icon" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </a>
      <div
        slot="content"
        class="session-hovercard__automations"
        aria-label={t("chat.sessionDetails.automations")}
        aria-busy={loading() ? "true" : "false"}
      >
        <div class="session-hovercard__automation-caption">
          {t("chat.sessionDetails.automations")}
        </div>
        <Show when={state().cronJobsTotal > 1}>
          <div
            class="session-hovercard__automation-list"
            aria-label={t("sessionHovercard.selectAutomation")}
          >
            <For each={state().cronJobs} keyed={(job) => job.id}>
              {(job) => (
                <button
                  type="button"
                  class="session-hovercard__automation-choice"
                  aria-pressed={selected()?.id === job().id ? "true" : "false"}
                  onClick={() => select(job().id)}
                >
                  <span>{job().name.trim() || job().id}</span>
                  <small>{status(job())}</small>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={selected()}>
          {(value) => (
            <section class="session-hovercard__automation-detail">
              <div class="session-hovercard__automation-name">
                {value().name.trim() || value().id}
              </div>
              <div class="session-hovercard__automation-meta">{schedule(value())}</div>
              <div
                class="session-hovercard__automation-meta"
                data-running={isCronJobRunning(value()) ? "true" : "false"}
              >
                {status(value())}
                <Show
                  when={
                    value().enabled &&
                    !isCronJobRunning(value()) &&
                    value().state.nextRunAtMs !== undefined
                  }
                >
                  {" · "}
                  {t("sessionHovercard.automationNext", {
                    time: formatRelativeTimestamp(value().state.nextRunAtMs),
                  })}
                </Show>
              </div>
              <Show when={value().state.lastRunAtMs !== undefined}>
                <div class="session-hovercard__automation-meta">
                  {t("sessionHovercard.automationLast", {
                    status: t(
                      "sessionHovercard.automationStatuses." + resolveCronJobLastRunStatus(value()),
                    ),
                    time: formatRelativeTimestamp(value().state.lastRunAtMs),
                  })}
                </div>
              </Show>
              <Show when={value().state.lastError}>
                <p class="session-hovercard__automation-error">{value().state.lastError}</p>
              </Show>
              <div class="session-hovercard__automation-instructions">
                <div class="session-hovercard__automation-caption">
                  {t("sessionHovercard.automationInstructions")}
                </div>
                <p class="session-hovercard__automation-preview">{instructions(value())}</p>
                <details>
                  <summary>{t("sessionHovercard.automationFullInstructions")}</summary>
                  <pre>{instructions(value())}</pre>
                </details>
              </div>
              <OpenLink job={value()} />
            </section>
          )}
        </Show>
        <Show when={message() !== undefined}>
          <div class="session-hovercard__automation-message" role="status">
            {message()}
          </div>
        </Show>
        <Show when={state().cronJobsError}>
          <button
            type="button"
            class="chip"
            disabled={loading() || !state().connected}
            onClick={() => void load()}
          >
            {t("common.retry")}
          </button>
        </Show>
        <Show when={state().cronJobsHasMore}>
          <button type="button" class="chip" disabled={loading()} onClick={() => void load(true)}>
            {t("chat.sessionDetails.automationMore")}
          </button>
        </Show>
        <Show when={!selected()}>
          <OpenLink />
        </Show>
      </div>
    </openclaw-tooltip>
  );
}
