import type { JSX } from "@solidjs/web";
import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  isPending,
  latest,
  onSettled,
  untrack,
} from "solid-js";
import type { CronCompactJob } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { gatewayPresentationScope } from "../../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { loadCompactCronJobsPage, retireCronJobsRequest } from "../../../lib/cron/jobs.ts";
import { createInitialCronState } from "../../../lib/cron/state.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod, canPresentGatewayMethod } from "../../../lib/gateway-methods.ts";
import { createGatewayRetryOwner } from "../../../lib/gateway-retry.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { resolveUiConversationIdentity } from "../../../lib/sessions/session-key.ts";
import { HoverMarquee } from "../../../lib/solid/hover-marquee.tsx";
import "../../../styles/chat/summary-automations.css";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import { sessionAutomationSchedule } from "./session-automation-schedule.ts";

registerEnglishCatalog(registerChatSessionEnglish);

class AutomationReadError extends Error {
  constructor(
    message: string,
    readonly readDenied: boolean,
  ) {
    super(message);
  }
}

export type SessionAutomationInventoryProps = {
  gateway: ApplicationGateway | undefined;
  sessionKey: string;
  presented: boolean;
};

/** Create once in the session owner; desktop and mobile consume this same inventory. */
export function createSessionAutomationInventory(
  props: SessionAutomationInventoryProps,
  host: () => HTMLElement | undefined,
) {
  // Unrelated parent prop replacements must not reset inventory or presentation.
  const gateway = createMemo(() => props.gateway);
  const sessionKey = createMemo(() => props.sessionKey);
  const presented = createMemo(() => props.presented);
  const binding = createMemo(() => ({ source: gateway(), key: sessionKey() }));
  const [revision, setRevision] = createSignal(0);
  const publish = () => setRevision((value) => value + 1);
  // The loader owns synchronous request state; Solid only observes its revision.
  let cron = createInitialCronState<CronCompactJob>();
  const [receipt, setReceipt] = createSignal<{
    state: typeof cron;
    result: Promise<void>;
  }>();
  let readAccess = false;
  let dirty = true;
  let retryPending = false;
  const retry = createGatewayRetryOwner();
  let active = true;
  let presentationScope = 0;
  const visible = (isPresented = presented()) =>
    active &&
    host()?.isConnected === true &&
    isPresented &&
    host()?.ownerDocument.visibilityState !== "hidden";
  const state = () => {
    revision();
    return cron;
  };
  const scope = createMemo(state);
  // Observe the admitted read, including its trailing refresh. Consumers never send an RPC.
  // Throw the settled failure in the readiness slot so pending probes can retain the retry UI.
  const read = createMemo<AutomationReadError | undefined>(() => {
    const current = scope();
    const admitted = receipt();
    return admitted?.state === current
      ? admitted.result.then(() => {
          if (current.cronJobsError) {
            return new AutomationReadError(
              current.cronJobsError,
              current.cronJobsReadDenied === true,
            );
          }
          return undefined;
        })
      : Promise.resolve(undefined);
  });

  const readable = () => {
    revision();
    return readAccess;
  };

  function reset(source: ApplicationGateway | undefined, key: string, retain = false) {
    retry.reset();
    retryPending = false;
    retireCronJobsRequest(cron);
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
    const nextPresentationScope = source ? gatewayPresentationScope(source).key : 0;
    if (
      retain &&
      readAccess &&
      nextPresentationScope !== 0 &&
      nextPresentationScope === presentationScope
    ) {
      next.cronJobs = cron.cronJobs;
      next.cronJobsSnapshotRevision = cron.cronJobsSnapshotRevision;
      next.cronJobsTotal = cron.cronJobsTotal;
      next.cronJobsHasMore = cron.cronJobsHasMore;
      next.cronJobsNextOffset = cron.cronJobsNextOffset;
    }
    presentationScope = nextPresentationScope;
    cron = next;
    dirty = true;
    publish();
  }

  async function load({
    append = false,
    isPresented = presented(),
    event,
  }: {
    append?: boolean;
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
    retry.cancel();
    retryPending = false;
    dirty = false;
    const alreadyLoading = current.cronLoading || current.cronJobsLoadingMore;
    const pending = loadCompactCronJobsPage(current, { append, event });
    // Coalesced events return early; retain the active read's completion receipt.
    if (!alreadyLoading && (current.cronLoading || current.cronJobsLoadingMore)) {
      setReceipt({ state: current, result: pending });
    }
    publish();
    await pending;
    if (cron !== current || !active || !host()?.isConnected) {
      return;
    }
    // The loader pauses trailing reads while hidden; retain one visible catch-up.
    const failed = current.cronJobsError !== null;
    dirty ||= !visible() || failed;
    if (failed && visible() && !current.cronJobsReadDenied) {
      retryPending = true;
      retry.schedule(() => {
        retryPending = false;
        if (cron === current) {
          void load();
        }
      });
    } else if (!failed || current.cronJobsReadDenied) {
      retry.reset();
    }
    publish();
  }

  // Mount this outlet once in the session owner; consumers share its retained inventory.
  const lifecycle = (
    <Show when={binding()} keyed>
      {({ source, key }) => {
        onSettled(() => {
          reset(source, key);
          if (!source) {
            return undefined;
          }
          const connection = createGatewayConnectionLifecycle(source.snapshot);
          let identity = JSON.stringify(resolveUiConversationIdentity(source.snapshot, key));
          // Reject obsolete event delivery before queued binding cleanup runs.
          const current = () => props.gateway === source && props.sessionKey === key;
          // Connection publications retire request scopes before the next cron event is delivered.
          const unsubscribe = source.subscribe((snapshot) => {
            if (!current()) {
              return;
            }
            const nextIdentity = JSON.stringify(resolveUiConversationIdentity(snapshot, key));
            const changed = connection.transition(snapshot);
            const nextReadAccess = canPresentGatewayMethod(snapshot, "cron.list", "operator.read", {
              requireAdvertisement: false,
            });
            if (changed || identity !== nextIdentity || readAccess !== nextReadAccess) {
              reset(source, key, identity === nextIdentity && readAccess === nextReadAccess);
              identity = nextIdentity;
            }
            if (dirty && !retryPending && !cron.cronJobsReadDenied) {
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
            connection.dispose();
            retry.reset();
            retryPending = false;
            retireCronJobsRequest(cron);
          };
        });
        return (
          <For each={[presented()]}>
            {(shown) => {
              onSettled(() => {
                if (shown && !cron.cronJobsReadDenied) {
                  void load({ isPresented: true });
                }
                return () => {
                  retry.cancel();
                  retryPending = false;
                  dirty = true;
                };
              });
              return null;
            }}
          </For>
        );
      }}
    </Show>
  );
  onSettled(() => {
    const activate = () => {
      if (!visible()) {
        retry.cancel();
        retryPending = false;
      } else if (dirty && !cron.cronJobsReadDenied) {
        void load();
      }
    };
    const stopVisibility = listen(host()!.ownerDocument, "visibilitychange", activate);
    const stopFocus = listen(globalThis, "focus", activate);
    activate();
    return () => {
      active = false;
      retry.reset();
      stopVisibility();
      stopFocus();
    };
  });

  return {
    lifecycle,
    jobs: (): readonly CronCompactJob[] => state().cronJobs,
    total: () => state().cronJobsTotal,
    hasMore: () => state().cronJobsHasMore,
    loading: () => state().cronLoading || state().cronJobsLoadingMore,
    loaded: () => state().cronJobsSnapshotRevision !== null,
    connected: () => scope().connected,
    available: () => readable() && Boolean(state().cronSessionFilter),
    readable,
    error: () => state().cronJobsError !== null,
    read,
    refresh: () => load(),
    loadMore: () => load({ append: true }),
  };
}

export type SessionAutomationInventory = ReturnType<typeof createSessionAutomationInventory>;

/** Readiness is separate from rows so refresh errors retain their DOM and focus. */
export function SessionAutomationRead(props: {
  inventory: SessionAutomationInventory;
  loading?: JSX.Element;
  error: JSX.Element;
  readDeniedOnly?: boolean;
}) {
  const ready = () => {
    const failure = latest(props.inventory.read);
    if (failure) {
      throw failure;
    }
    return !props.inventory.loaded() && isPending(props.inventory.read) ? props.loading : null;
  };
  return (
    <Errored
      fallback={(error) => {
        const cause = error();
        return !props.readDeniedOnly ||
          (cause instanceof AutomationReadError && cause.readDenied) ? (
          <Loading>{props.error}</Loading>
        ) : null;
      }}
    >
      <Loading fallback={props.loading}>{ready()}</Loading>
    </Errored>
  );
}

export type ChatSummaryAutomationsProps = SessionAutomationInventoryProps & {
  /** Supplied only by the native desktop Details composition. */
  desktop?: { expanded: boolean; onExpandedChange: (expanded: boolean) => void };
  /** Stable session-owned instance shared with mobile, when supplied by the parent. */
  inventory?: SessionAutomationInventory;
  onNavigate?: (jobId: string) => void;
};

export function ChatSummaryAutomations(props: ChatSummaryAutomationsProps) {
  let host!: HTMLElement;
  const context = useOptionalApplication();
  const jobLinks = new Map<string, HTMLAnchorElement>();
  const registerJobLink = (key: string) => (element: HTMLAnchorElement) => {
    jobLinks.set(key, element);
    return () => {
      if (jobLinks.get(key) === element) {
        jobLinks.delete(key);
      }
    };
  };
  const initialInventory = untrack(() => props.inventory);
  const inventory = initialInventory ?? createSessionAutomationInventory(props, () => host);
  const presented = createMemo(() => props.presented);
  const sessionKey = createMemo(() => props.sessionKey);
  // Reopening or replacing the session resets only the local reveal count.
  const [shown, setShown] = createSignal(() => {
    presented();
    sessionKey();
    return 10;
  });
  const jobs = () => inventory.jobs().slice(0, shown());
  const hasCachedRows = () => inventory.jobs().length > shown();
  const more = () => hasCachedRows() || (inventory.hasMore() && !inventory.error());

  async function reveal(button: HTMLButtonElement) {
    const key = props.sessionKey;
    const source = props.gateway;
    const first = jobs().length;
    const count = shown() + 10;
    // Revealing retained rows needs no network request, even during a failed refresh.
    if (!hasCachedRows()) {
      if (
        inventory.error() ||
        inventory.loading() ||
        !inventory.connected() ||
        !inventory.hasMore()
      ) {
        return;
      }
      await inventory.loadMore();
      if (inventory.error()) {
        return;
      }
    }
    if (
      props.sessionKey !== key ||
      props.gateway !== source ||
      !props.presented ||
      !host.isConnected
    ) {
      return;
    }
    setShown(Math.min(count, inventory.jobs().length));
    if (host.ownerDocument.activeElement === button) {
      const firstRevealedId = inventory.jobs()[first]?.id;
      onSettled(() => {
        const target = firstRevealedId ? jobLinks.get(firstRevealedId) : undefined;
        const activeElement = host.ownerDocument.activeElement;
        if (
          props.sessionKey === key &&
          props.gateway === source &&
          props.presented &&
          host.isConnected &&
          target?.isConnected &&
          (activeElement === button || activeElement === host.ownerDocument.body)
        ) {
          target.focus();
        }
      });
    }
  }

  async function retry(button: HTMLButtonElement) {
    const key = props.sessionKey;
    const source = props.gateway;
    const focused = host.ownerDocument.activeElement === button;
    await inventory.refresh();
    if (
      props.sessionKey !== key ||
      props.gateway !== source ||
      inventory.error() ||
      !props.presented ||
      !host.isConnected
    ) {
      return;
    }
    // Only move focus when the successful retry removed the focused control.
    if (focused) {
      onSettled(() => {
        const target = jobLinks.get(inventory.jobs()[0]?.id ?? "");
        if (
          props.sessionKey === key &&
          props.gateway === source &&
          props.presented &&
          host.isConnected &&
          target?.isConnected &&
          host.ownerDocument.activeElement === host.ownerDocument.body
        ) {
          target.focus();
        }
      });
    }
  }

  function jobState(job: CronCompactJob) {
    if (job.autoDisabled) {
      return t("chat.sessionDetails.automationAttention");
    }
    if (!job.enabled) {
      return t("chat.sessionDetails.automationPaused");
    }
    if (inventory.connected() && job.runningAtMs !== undefined) {
      return t("common.running");
    }
    return job.schedule ? sessionAutomationSchedule(job.schedule) : "";
  }
  const errorNotice = () =>
    inventory.connected() && (
      <div class="chat-summary__automation-error">
        <span role="status">
          {t(
            inventory.loaded()
              ? "chat.sessionDetails.automationUpdateError"
              : "chat.sessionDetails.automationError",
          )}
        </span>
        <button
          type="button"
          class="chat-summary__automation-retry"
          aria-disabled={isPending(inventory.read) ? "true" : "false"}
          onClick={(event) => void retry(event.currentTarget)}
        >
          {t("common.retry")}
        </button>
      </div>
    );
  const content = () => (
    <div class="chat-summary__automations" aria-busy={isPending(inventory.read) ? "true" : "false"}>
      <For each={jobs()} keyed={(job) => job.id}>
        {(job) => {
          let row: HTMLAnchorElement | undefined;
          const search = () => `?${new URLSearchParams({ job: job().id })}`;
          const running = () =>
            inventory.connected() &&
            job().enabled &&
            !job().autoDisabled &&
            job().runningAtMs !== undefined;
          const state = createMemo(() => jobState(job()));
          const metadataTitle = () => {
            const value = job();
            const timezone = value.schedule?.kind === "cron" ? value.schedule.tz : undefined;
            return timezone ? `${state()} (${timezone})` : props.desktop ? undefined : state();
          };
          return (
            <a
              ref={[
                (element) => {
                  row = element;
                },
                elementRef(registerJobLink(job().id)),
              ]}
              class="chat-summary__automation"
              href={`${pathForRoute("cron", context?.basePath ?? "")}${search()}`}
              title={props.desktop ? undefined : job().name.trim() || job().id}
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
                {!job().enabled && !job().autoDisabled && (
                  <span class="chat-summary__automation-paused">
                    <Icon name="pause" />
                  </span>
                )}
                {job().autoDisabled && <span class="chat-summary__automation-attention" />}
              </span>
              <HoverMarquee
                class="chat-summary__automation-title"
                content={job().name.trim() || job().id}
                options={{ host: () => row }}
              />
              {state() && (
                <span
                  class={[
                    "chat-summary__automation-state",
                    { "is-attention": Boolean(job().autoDisabled) },
                  ]}
                  title={metadataTitle()}
                >
                  {running() ? (
                    <>
                      <span class="session-run-spinner" aria-hidden="true" />
                      <span class="sr-only">{state()}</span>
                    </>
                  ) : (
                    <HoverMarquee
                      class="chat-summary__automation-metadata"
                      content={state()}
                      options={{ host: () => row, stationary: true }}
                    />
                  )}
                </span>
              )}
            </a>
          );
        }}
      </For>
      {more() && (
        <button
          type="button"
          class="chat-summary__automation-more"
          disabled={!hasCachedRows() && (isPending(inventory.read) || !inventory.connected())}
          onClick={(event) => void reveal(event.currentTarget)}
        >
          {t("chat.sessionDetails.automationShowMore")}
        </button>
      )}
    </div>
  );
  return (
    <openclaw-chat-summary-automations ref={(element) => (host = element)}>
      {initialInventory ? null : inventory.lifecycle}
      <Loading>
        <Show when={inventory.readable()}>
          <Show when={inventory.jobs().length > 0}>
            <Show
              when={props.desktop}
              fallback={
                <details class="chat-details__group" data-details-group="automations" open>
                  <summary class="chat-details__caption">
                    {t("chat.sessionDetails.automations")}
                    <Icon name="chevronDown" />
                  </summary>
                  {content()}
                </details>
              }
            >
              {(desktop) => (
                <ChatDetailsDesktopSection
                  section="automations"
                  title={t("chat.sessionDetails.automations")}
                  expanded={desktop().expanded}
                  presented={props.presented}
                  onExpandedChange={(expanded) => desktop().onExpandedChange(expanded)}
                >
                  {content()}
                </ChatDetailsDesktopSection>
              )}
            </Show>
          </Show>
          <SessionAutomationRead
            inventory={inventory}
            readDeniedOnly
            error={
              <div
                class="chat-summary__automations"
                aria-busy={isPending(inventory.read) ? "true" : "false"}
              >
                {errorNotice()}
              </div>
            }
          />
        </Show>
      </Loading>
    </openclaw-chat-summary-automations>
  );
}
