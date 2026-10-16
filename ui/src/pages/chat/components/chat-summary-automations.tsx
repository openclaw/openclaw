import { For, Show, createEffect, createMemo, createSignal, onSettled, untrack } from "solid-js";
import type { CronCompactJob } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { createInitialCronState } from "../../../lib/cron/index.ts";
import { loadCompactCronJobsPage } from "../../../lib/cron/jobs.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { formatCronSchedule } from "../../../lib/presenter.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { resolveUiConversationIdentity } from "../../../lib/sessions/session-key.ts";
import "../../../styles/chat/summary-automations.css";

type Props = {
  gateway: ApplicationGateway | undefined;
  sessionKey: string;
  presented: boolean;
  onNavigate?: (jobId: string) => void;
};

export function ChatSummaryAutomations(props: Props) {
  let host!: HTMLElement;
  const context = useOptionalApplication();
  const gateway = createMemo(() => props.gateway);
  const sessionKey = createMemo(() => props.sessionKey);
  const presented = createMemo(() => props.presented);
  const [revision, setRevision] = createSignal(0);
  const publish = () => setRevision((value) => value + 1);
  // The loader owns synchronous request state; Solid only observes its revision.
  let cron = createInitialCronState<CronCompactJob>();
  let showError = false;
  let dirty = true;
  let active = true;
  let presentationScope = 0;
  let focusAfterCommit: typeof cron | undefined;
  const visible = () =>
    active &&
    host.isConnected &&
    untrack(presented) &&
    host.ownerDocument.visibilityState !== "hidden";
  const state = () => {
    revision();
    return cron;
  };
  const error = () => {
    revision();
    return showError;
  };

  function reset(retain = false) {
    const source = untrack(gateway);
    const next = createInitialCronState<CronCompactJob>({
      client: source?.snapshot.client ?? null,
      connected: source?.snapshot.phase === "connected",
    });
    const identity = resolveUiConversationIdentity(source?.snapshot ?? {}, untrack(sessionKey));
    next.cronSessionFilter =
      identity.sessionKey && identity.agentId
        ? { sessionKey: identity.sessionKey, sessionAgentId: identity.agentId }
        : undefined;
    next.cronJobsSortBy = "name";
    next.canRefresh = () =>
      untrack(() => cron === next && visible() && Boolean(next.cronSessionFilter));
    const scope = source ? gatewayPresentationScope(source).key : 0;
    if (retain && scope !== 0 && scope === presentationScope) {
      next.cronJobs = cron.cronJobs;
      next.cronJobsSnapshotRevision = cron.cronJobsSnapshotRevision;
      next.cronJobsTotal = cron.cronJobsTotal;
      next.cronJobsHasMore = cron.cronJobsHasMore;
      next.cronJobsNextOffset = cron.cronJobsNextOffset;
    }
    presentationScope = scope;
    cron = next;
    showError = false;
    dirty = true;
    publish();
  }

  async function load(append = false, retry?: HTMLButtonElement) {
    const current = cron;
    if (
      !visible() ||
      !current.connected ||
      !current.cronSessionFilter ||
      current.cronLoading ||
      current.cronJobsLoadingMore
    ) {
      return;
    }
    dirty = false;
    const pending = loadCompactCronJobsPage(current, { append });
    publish();
    await pending;
    if (cron !== current || !active || !host.isConnected) {
      return;
    }
    showError = current.cronJobsError !== null;
    const restoreFocus = retry && visible() && host.ownerDocument.activeElement === retry;
    if (restoreFocus && !showError) {
      focusAfterCommit = current;
    }
    publish();
  }

  createEffect(
    () => [gateway(), sessionKey()] as const,
    ([source, key]) => {
      reset();
      if (!source) {
        return undefined;
      }
      const lifecycle = createGatewayConnectionLifecycle(source.snapshot);
      let identity = JSON.stringify(resolveUiConversationIdentity(source.snapshot, key));
      const unsubscribe = source.subscribe((snapshot) => {
        if (untrack(() => props.gateway) !== source) {
          return;
        }
        const nextIdentity = JSON.stringify(
          resolveUiConversationIdentity(
            snapshot,
            untrack(() => props.sessionKey),
          ),
        );
        const changed = lifecycle.transition(snapshot);
        if (changed || identity !== nextIdentity) {
          reset(identity === nextIdentity && snapshot.phase !== "connected");
          identity = nextIdentity;
        }
        if (dirty) {
          void load();
        }
      });
      const unsubscribeEvents = source.subscribeEvents((event) => {
        if (untrack(() => props.gateway) === source && event.event === "cron") {
          dirty = true;
          void load();
        }
      });
      void load();
      return () => {
        unsubscribe();
        unsubscribeEvents();
        lifecycle.dispose();
      };
    },
  );
  createEffect(presented, (value) => {
    if (value) {
      dirty = true;
      void load();
    }
  });
  createEffect(revision, () => {
    const current = focusAfterCommit;
    focusAfterCommit = undefined;
    if (
      current === cron &&
      visible() &&
      host.ownerDocument.activeElement === host.ownerDocument.body
    ) {
      host
        .querySelector<HTMLElement>(".chat-summary__automation, .chat-summary__automation-message")
        ?.focus();
    }
  });
  onSettled(() => {
    const activate = () => {
      if (dirty) {
        void load();
      }
    };
    host.ownerDocument.addEventListener("visibilitychange", activate);
    globalThis.addEventListener("focus", activate);
    activate();
    return () => {
      active = false;
      host.ownerDocument.removeEventListener("visibilitychange", activate);
      globalThis.removeEventListener("focus", activate);
    };
  });

  const loading = () => state().cronLoading || state().cronJobsLoadingMore;
  const loaded = () => state().cronJobsSnapshotRevision !== null;
  function jobState(job: CronCompactJob) {
    if (job.autoDisabled) {
      return t("chat.sessionDetails.automationAttention");
    }
    if (!job.enabled) {
      return t("chat.sessionDetails.automationPaused");
    }
    return state().connected && job.runningAtMs !== undefined
      ? t("common.running")
      : job.schedule
        ? formatCronSchedule({ schedule: job.schedule })
        : t("chat.sessionDetails.automationEnabled");
  }
  const content = () => (
    <div class="chat-summary__automations" aria-busy={loading() ? "true" : "false"}>
      {!state().connected && loaded() && (
        <div class="chat-summary__automation-message" role="status">
          {t("chat.sessionDetails.automationOffline")}
        </div>
      )}
      <For each={state().cronJobs} keyed={(job) => job.id}>
        {(job) => {
          const search = () => `?${new URLSearchParams({ job: job().id })}`;
          return (
            <a
              class="chat-summary__automation"
              href={`${pathForRoute("cron", context?.basePath ?? "")}${search()}`}
              onClick={(event) => {
                if (shouldHandleNavigationClick(event) && (props.onNavigate || context)) {
                  event.preventDefault();
                  if (props.onNavigate) {
                    props.onNavigate(job().id);
                  } else {
                    context?.navigate("cron", { search: search() });
                  }
                }
              }}
            >
              <span class="chat-summary__automation-icon" aria-hidden="true">
                <Icon name="clock" />
              </span>
              <span class="chat-summary__automation-title">{job().name.trim() || job().id}</span>
              <span class="chat-summary__automation-state" title={jobState(job())}>
                {jobState(job())}
              </span>
            </a>
          );
        }}
      </For>
      {error() ? (
        <div class="chat-summary__automation-error">
          <span role="status">{t("chat.sessionDetails.automationError")}</span>
          <button
            type="button"
            class="chip chat-summary__automation-retry"
            aria-disabled={loading() || !state().connected ? "true" : "false"}
            onClick={(event) => void load(false, event.currentTarget)}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : (
        !loaded() && (
          <div class="chat-summary__automation-message" role="status" tabindex={-1}>
            {!state().cronSessionFilter
              ? t("chat.sessionDetails.automationUnavailable")
              : !state().connected
                ? t("chat.sessionDetails.automationOffline")
                : t("chat.sessionDetails.automationLoading")}
          </div>
        )
      )}
      {state().cronJobsHasMore && !error() && (
        <button
          type="button"
          class="chip chat-summary__automation-more"
          disabled={loading() || !state().connected}
          onClick={() => void load(true)}
        >
          {t("chat.sessionDetails.automationMore")}
        </button>
      )}
    </div>
  );
  return (
    <openclaw-chat-summary-automations
      ref={(element) => {
        host = element;
      }}
    >
      <Show
        when={state().cronJobs.length > 0}
        fallback={<Show when={props.gateway && (!loaded() || error())}>{content()}</Show>}
      >
        <details class="chat-details__group" data-details-group="automations" open>
          <summary class="chat-details__caption">
            {t("chat.sessionDetails.automations")}
            <span>{state().cronJobsTotal ?? state().cronJobs.length}</span>
            <Icon name="chevronDown" />
          </summary>
          {content()}
        </details>
      </Show>
    </openclaw-chat-summary-automations>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-summary-automations": HTMLAttributes<HTMLElement>;
    }
  }
}
