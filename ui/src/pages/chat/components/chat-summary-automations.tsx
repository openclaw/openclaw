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
} from "solid-js";
import type { CronCompactJob } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Tooltip } from "../../../components/solid/tooltip.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { createSessionAutomationSchedule } from "../../../lib/cron/session-automation-schedule-loader.ts";
import { sessionAutomationNextRun } from "../../../lib/cron/session-automation-schedule-non-cron.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/chat/summary-automations.css";
import { HoverMarquee } from "../../../lib/solid/hover-marquee.tsx";
import type { DetailsAutomation, DetailsSnapshotPatch } from "../chat-details-snapshot.ts";
import type { ChatDetailsSnapshot } from "../session-details-snapshot-schema.ts";
import { ReportDesktopDetailsContent } from "./chat-details-content-presence.ts";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import {
  AutomationReadError,
  createSessionAutomationInventory,
  readCachedSessionAutomations,
  type SessionAutomationInventory,
  type SessionAutomationInventoryProps,
} from "./session-automation-inventory.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

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
  inventory?: SessionAutomationInventory;
  cached?: ChatDetailsSnapshot["automations"];
  onDetailsSnapshot?: (patch: DetailsSnapshotPatch) => void;
  /** Reset local reveal/focus intent without retiring the logical inventory. */
  presentationIdentity?: object;
  /** Supplied only by the native desktop Details composition. */
  desktop?: { expanded: boolean; onExpandedChange: (expanded: boolean) => void };
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
  let localInventory: SessionAutomationInventory | undefined;
  const inventory =
    props.inventory ?? (localInventory = createSessionAutomationInventory(props, () => host));
  const presented = createMemo(() => props.presented);
  const sessionKey = createMemo(() => props.sessionKey);
  const presentation = createMemo(() => props.presentationIdentity);
  // Reopening or replacing the presentation resets only the local reveal count.
  const [shown, setShown] = createSignal(() => {
    presentation();
    presented();
    sessionKey();
    return 10;
  });
  const formatSchedule = createSessionAutomationSchedule();
  const cached = () => readCachedSessionAutomations(inventory, props.gateway, props.cached);
  const pending = () => (cached() ? inventory.loading() : isPending(inventory.read));
  // Closing the row DOM must not erase the bounded offline preview.
  const jobs = createMemo<DetailsAutomation[]>(() =>
    inventory.loaded()
      ? inventory
          .jobs()
          .slice(0, props.desktop && !props.desktop.expanded ? 10 : shown())
          .map((job) => ({
            id: job.id,
            name: job.name,
            disabled: !job.enabled || undefined,
            autoDisabled: job.autoDisabled ? true : undefined,
            running:
              job.runningAtMs === undefined
                ? undefined
                : (inventory.connected() && job.enabled && !job.autoDisabled) || undefined,
            state: jobState(job),
            nextRunAtMs: job.enabled && !job.autoDisabled ? job.nextRunAtMs : null,
          }))
      : (cached()?.rows ?? []),
  );
  const hasCachedRows = () => inventory.jobs().length > shown();
  const unavailable = () => inventory.error() || inventory.loading() || !inventory.connected();
  const more = () =>
    cached()?.more ?? (hasCachedRows() || (inventory.hasMore() && !inventory.error()));
  const receipt = createMemo(() =>
    inventory.loaded() && props.onDetailsSnapshot
      ? {
          write: props.onDetailsSnapshot,
          automations: {
            rows: jobs().slice(0, 10),
            more: inventory.jobs().length > 10 || inventory.hasMore(),
          },
        }
      : undefined,
  );

  async function reveal(button: HTMLButtonElement) {
    const key = sessionKey();
    const presentationIdentity = props.presentationIdentity;
    const source = props.gateway;
    const first = jobs().length;
    const count = shown() + 10;
    // Revealing retained rows needs no network request, even during a failed refresh.
    if (!hasCachedRows()) {
      if (unavailable() || !inventory.hasMore()) {
        return;
      }
      await inventory.loadMore();
      if (inventory.error()) {
        return;
      }
    }
    // Cancel the old presentation before reading props held by an async frame.
    if (
      latest(() => props.presentationIdentity) !== presentationIdentity ||
      sessionKey() !== key ||
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
          latest(() => props.presentationIdentity) === presentationIdentity &&
          sessionKey() === key &&
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
    const key = sessionKey();
    const presentationIdentity = props.presentationIdentity;
    const source = props.gateway;
    const focused = host.ownerDocument.activeElement === button;
    await inventory.refresh();
    if (
      latest(() => props.presentationIdentity) !== presentationIdentity ||
      sessionKey() !== key ||
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
          latest(() => props.presentationIdentity) === presentationIdentity &&
          sessionKey() === key &&
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
    return job.schedule ? formatSchedule(job.schedule) : "";
  }
  const errorNotice = () =>
    inventory.connected() && (
      <div class="chat-summary__automation-error">
        <ReportDesktopDetailsContent />
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
    <div class="chat-summary__automations" aria-busy={pending() ? "true" : "false"}>
      <For each={props.desktop && !props.desktop.expanded ? [] : jobs()} keyed={(job) => job.id}>
        {(job) => {
          let row: HTMLAnchorElement | undefined;
          const search = () => `?${new URLSearchParams({ job: job().id })}`;
          const running = () => job().running;
          const state = () => job().state;
          // Older cached snapshots lack nextRunAtMs; show no tooltip rather than guess.
          const nextRun = () => {
            const at = job().nextRunAtMs;
            return at === undefined ? undefined : sessionAutomationNextRun(at);
          };
          return (
            <Tooltip content={nextRun()} disabled={nextRun() === undefined}>
              <a
                ref={[
                  (element) => {
                    row = element;
                  },
                  elementRef(registerJobLink(job().id)),
                ]}
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
                  {job().disabled && !job().autoDisabled && (
                    <span class="chat-summary__automation-paused">
                      <Icon name="pause" />
                    </span>
                  )}
                  {job().autoDisabled && <span class="chat-summary__automation-attention" />}
                </span>
                <span class="chat-summary__automation-copy">
                  <span class="chat-summary__automation-heading">
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
                  </span>
                </span>
              </a>
            </Tooltip>
          );
        }}
      </For>
      {more() && (
        <button
          type="button"
          class="chat-summary__automation-more"
          aria-disabled={!hasCachedRows() && unavailable() ? "true" : undefined}
          onClick={(event) => void reveal(event.currentTarget)}
        >
          {t("chat.sessionDetails.automationShowMore")}
        </button>
      )}
    </div>
  );
  return (
    <openclaw-chat-summary-automations ref={(element) => (host = element)}>
      {localInventory?.lifecycle}
      <ChatLazyBoundary errorContent={<ReportDesktopDetailsContent />}>
        <Show when={receipt()} keyed>
          {(value) => {
            onSettled(() => value.write({ automations: value.automations }));
            return null;
          }}
        </Show>
        <Show when={inventory.readable() || cached()}>
          <Show when={inventory.jobs().length > 0 || (cached()?.rows.length ?? 0) > 0}>
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
      </ChatLazyBoundary>
    </openclaw-chat-summary-automations>
  );
}
