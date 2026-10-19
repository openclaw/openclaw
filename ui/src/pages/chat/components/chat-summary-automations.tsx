import { For, Show, createMemo, createSignal, onSettled, untrack } from "solid-js";
import type { CronCompactJob } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { loadCompactCronJobsPage } from "../../../lib/cron/jobs.ts";
import { createInitialCronState } from "../../../lib/cron/state.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod, canPresentGatewayMethod } from "../../../lib/gateway-methods.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { formatCronSchedule } from "../../../lib/presenter.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
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
  // Unrelated parent prop replacements must not reset inventory or presentation.
  const gateway = createMemo(() => props.gateway);
  const sessionKey = createMemo(() => props.sessionKey);
  const presented = createMemo(() => props.presented);
  const binding = createMemo(() => ({ source: gateway(), key: sessionKey() }));
  const [revision, setRevision] = createSignal(0);
  const publish = () => setRevision((value) => value + 1);
  // The loader owns synchronous request state; Solid only observes its revision.
  let cron = createInitialCronState<CronCompactJob>();
  let showError = false;
  let readAccess = false;
  let dirty = true;
  let active = true;
  let presentationScope = 0;
  const jobLinks = new Map<string, HTMLAnchorElement>();
  let statusMessage: HTMLDivElement | undefined;
  const visible = (isPresented = presented()) =>
    active && host.isConnected && isPresented && host.ownerDocument.visibilityState !== "hidden";
  const state = () => {
    revision();
    return cron;
  };
  const error = () => {
    revision();
    return showError;
  };

  const readable = () => {
    revision();
    return readAccess;
  };

  function reset(source: ApplicationGateway | undefined, key: string, retain = false) {
    readAccess = canPresentGatewayMethod(source?.snapshot, "cron.list", "operator.read", {
      requireAdvertisement: false,
    });
    const next = createInitialCronState<CronCompactJob>({
      client: source?.snapshot.client ?? null,
      connected: source?.snapshot.phase === "connected",
    });
    const identity = resolveUiConversationIdentity(source?.snapshot ?? {}, key);
    next.cronSessionFilter =
      identity.sessionKey && identity.agentId
        ? { sessionKey: identity.sessionKey, sessionAgentId: identity.agentId }
        : undefined;
    next.cronJobsSortBy = "name";
    next.canRefresh = () =>
      cron === next &&
      visible() &&
      Boolean(next.cronSessionFilter) &&
      canCallGatewayMethod(source?.snapshot, "cron.list", "operator.read", {
        requireAdvertisement: false,
      });
    const scope = source ? gatewayPresentationScope(source).key : 0;
    if (retain && readAccess && scope !== 0 && scope === presentationScope) {
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

  async function load({
    append = false,
    retry,
    isPresented = presented(),
    event,
  }: {
    append?: boolean;
    retry?: HTMLButtonElement;
    isPresented?: boolean;
    event?: unknown;
  } = {}) {
    const current = cron;
    if (
      !readAccess ||
      !visible(isPresented) ||
      !current.connected ||
      !current.cronSessionFilter ||
      ((current.cronLoading || current.cronJobsLoadingMore) && !dirty)
    ) {
      return;
    }
    dirty = false;
    const pending = loadCompactCronJobsPage(current, { append, event });
    publish();
    await pending;
    if (cron !== current || !active || !host.isConnected) {
      return;
    }
    // The loader pauses trailing reads while hidden; retain one visible catch-up.
    dirty ||= !visible();
    showError = current.cronJobsError !== null;
    const restoreFocus = retry && visible() && host.ownerDocument.activeElement === retry;
    publish();
    if (restoreFocus && !showError) {
      onSettled(() => {
        if (
          current === cron &&
          visible() &&
          host.ownerDocument.activeElement === host.ownerDocument.body
        ) {
          const target = jobLinks.get(cron.cronJobs[0]?.id ?? "") ?? statusMessage;
          if (target?.isConnected) {
            target.focus();
          }
        }
      });
    }
  }

  function SourceLifetime(scope: { source: ApplicationGateway | undefined; key: string }) {
    onSettled(() => {
      const source = scope.source;
      const key = scope.key;
      reset(source, key);
      if (!source) {
        return undefined;
      }
      const lifecycle = createGatewayConnectionLifecycle(source.snapshot);
      let identity = JSON.stringify(resolveUiConversationIdentity(source.snapshot, key));
      // Reject obsolete event delivery before queued binding cleanup runs.
      const current = () => props.gateway === source && props.sessionKey === key;
      // Connection publications retire request scopes before the next cron event is delivered.
      const unsubscribe = source.subscribe((snapshot) => {
        if (!current()) {
          return;
        }
        const nextIdentity = JSON.stringify(resolveUiConversationIdentity(snapshot, key));
        const changed = lifecycle.transition(snapshot);
        const nextReadAccess = canPresentGatewayMethod(snapshot, "cron.list", "operator.read", {
          requireAdvertisement: false,
        });
        if (changed || identity !== nextIdentity || readAccess !== nextReadAccess) {
          reset(
            source,
            key,
            identity === nextIdentity &&
              readAccess === nextReadAccess &&
              snapshot.phase !== "connected",
          );
          identity = nextIdentity;
        }
        if (dirty) {
          void load();
        }
      });
      const unsubscribeEvents = source.subscribeEvents((event) => {
        if (current() && event.event === "cron") {
          dirty = true;
          void load({ event: event.payload });
        }
      });
      void load();
      return () => {
        unsubscribe();
        unsubscribeEvents();
        lifecycle.dispose();
      };
    });
    return null;
  }
  function PresentedLifetime() {
    onSettled(() => {
      void load({ isPresented: true });
      return () => {
        dirty = true;
      };
    });
    return null;
  }
  onSettled(() => {
    const activate = () => {
      if (dirty) {
        void load();
      }
    };
    const stopVisibility = listen(host.ownerDocument, "visibilitychange", activate);
    const stopFocus = listen(globalThis, "focus", activate);
    activate();
    return () => {
      active = false;
      stopVisibility();
      stopFocus();
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
          // Retry focus runs before row onSettled; register its stable keyed identity in the ref.
          const initialJobId = untrack(() => job().id);
          let link: HTMLAnchorElement;
          onSettled(() => () => {
            if (jobLinks.get(initialJobId) === link) {
              jobLinks.delete(initialJobId);
            }
          });
          return (
            <a
              ref={(element) => {
                link = element;
                jobLinks.set(initialJobId, element);
              }}
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
            onClick={(event) => void load({ retry: event.currentTarget })}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : (
        !loaded() && (
          <div
            ref={(element) => (statusMessage = element)}
            class="chat-summary__automation-message"
            role="status"
            tabindex={-1}
          >
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
          onClick={() => void load({ append: true })}
        >
          {t("chat.sessionDetails.automationMore")}
        </button>
      )}
    </div>
  );
  return (
    <openclaw-chat-summary-automations ref={(element) => (host = element)}>
      <Show when={binding()} keyed>
        {(scope) => <SourceLifetime source={scope.source} key={scope.key} />}
      </Show>
      <Show when={presented()}>
        <PresentedLifetime />
      </Show>
      <Show when={readable()}>
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
