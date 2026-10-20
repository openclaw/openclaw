import { For, Show, createMemo, onSettled, untrack } from "solid-js";
import type { CronCompactJob } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { formatCronSchedule } from "../../../lib/presenter.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSessionAutomationInventory } from "../../../lib/reactive/session-automation-inventory.ts";
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
  const inventory = projectSessionAutomationInventory();
  const jobLinks = new Map<string, HTMLAnchorElement>();
  let statusMessage: HTMLDivElement | undefined;
  const visible = () =>
    host.isConnected && presented() && host.ownerDocument.visibilityState !== "hidden";
  const state = () => inventory.read().cron;
  const error = () => inventory.read().error;
  const readable = () => inventory.read().readable;

  async function load({
    append = false,
    retry,
  }: { append?: boolean; retry?: HTMLButtonElement } = {}) {
    const current = state();
    let restoreFocus = false;
    // Observe completion before the projection commits away the focused Retry button.
    const stop = retry
      ? // oxlint-disable-next-line solid/reactivity -- Explicit owner notifications read current state synchronously.
        inventory.subscribe(() => {
          if (current === state() && !loading() && !error()) {
            restoreFocus = visible() && host.ownerDocument.activeElement === retry;
          }
        })
      : undefined;
    await inventory.load({ append });
    stop?.();
    if (restoreFocus) {
      onSettled(() => {
        if (
          current === state() &&
          visible() &&
          host.ownerDocument.activeElement === host.ownerDocument.body
        ) {
          const target = jobLinks.get(current.cronJobs[0]?.id ?? "") ?? statusMessage;
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
      inventory.replaceSource({
        gateway: source,
        sessionKey: key,
        document: host.ownerDocument,
        // Reject obsolete deliveries before queued binding cleanup runs.
        isVisible: () => props.gateway === source && props.sessionKey === key && visible(),
      });
    });
    return null;
  }
  function PresentedLifetime() {
    onSettled(() => {
      inventory.activate();
      return () => inventory.park();
    });
    return null;
  }

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
