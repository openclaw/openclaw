import { For, Show, action, createMemo, createOptimistic, createSignal, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { createTimeout } from "../../../lib/reactive/timers.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { getContextNoticeViewModel } from "./chat-composer-context-model.ts";
import {
  buildChatContextCategories,
  buildDeferredContextGroups,
  type ContextCategory,
  type ContextEntry,
  type ContextGroup,
} from "./chat-context-breakdown-model.ts";
import {
  ChatContextReport,
  contextLabelKeys,
  contextGroupLabelKeys,
} from "./chat-context-report.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "../../../styles/chat/context-breakdown.css";

type ContextPageDetails = Pick<
  ChatDetailsProps,
  "selectedSession" | "currentAgentId" | "pullRequestsGateway" | "runActive" | "onCompact"
>;
type Usage = NonNullable<ReturnType<typeof getContextNoticeViewModel>>;

function ContextEmpty(props: { message: string; onRetry?: () => void }) {
  return (
    <PanelEmptyState
      icon={<Icon name="layers" />}
      heading={t("chat.sessionDetails.context")}
      description={props.message}
      action={
        props.onRetry && (
          <button type="button" class="chat-context__refresh" onClick={() => props.onRetry?.()}>
            {t("common.retry")}
          </button>
        )
      }
    />
  );
}

function ContextEntries(props: { entries: ContextEntry[]; group?: ContextGroup }) {
  const name = (entry: ContextEntry) => {
    const prefix = props.group?.kind === "mcp" && props.group.name ? props.group.name + "." : "";
    return prefix && entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name;
  };
  return (
    <For each={props.entries} keyed={(entry) => entry.key}>
      {(entry) => (
        <div class="chat-context__entry">
          <span class="chat-context__entry-name" title={entry().path ?? entry().name}>
            {name(entry())}
            <Show when={entry().path}>
              <span class="chat-context__path">{entry().path!.replace(/[\\/][^\\/]*$/, "")}</span>
            </Show>
          </span>
          <span
            class={{ "chat-context__unverified": entry().tokens === null }}
            title={entry().tokens === null ? t("chat.sessionDetails.contextUnverified") : undefined}
          >
            {entry().tokens === null ? "—" : formatCompactTokenCount(entry().tokens!)}
          </span>
        </div>
      )}
    </For>
  );
}

function ContextList(props: {
  entries: ContextEntry[];
  groups?: ContextGroup[];
  category: string;
  kind: string;
}) {
  const [all, setAll] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let search: HTMLInputElement | undefined;
  const long = () => props.entries.length > 20;
  const groups = createMemo(() => {
    const needle = long() && all() ? query().trim().toLocaleLowerCase() : "";
    let remaining = long() && !all() ? 8 : Infinity;
    return (props.groups ?? [{ key: "", entries: props.entries }])
      .map((group) => {
        const entries = group.entries
          .filter(
            (entry) =>
              !needle ||
              (entry.name + " " + (entry.path ?? "")).toLocaleLowerCase().includes(needle),
          )
          .slice(0, remaining);
        remaining -= entries.length;
        return { group: "kind" in group ? group : undefined, key: group.key, entries };
      })
      .filter((group) => group.entries.length > 0);
  });
  return (
    <div class="chat-context__accordion">
      <Show when={long() && all()}>
        <label class="chat-context__search">
          <Icon name="search" />
          <input
            ref={(element) => {
              search = element;
            }}
            type="search"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            aria-label={t("chat.sessionDetails.contextSearch", { category: props.category })}
            placeholder={t(
              props.kind === "skills"
                ? "chat.sessionDetails.contextSearchSkills"
                : props.kind === "files"
                  ? "chat.sessionDetails.contextSearchFiles"
                  : props.kind === "tools" || props.kind === "deferred"
                    ? "chat.sessionDetails.contextSearchTools"
                    : "chat.sessionDetails.contextSearchCount",
              {
                count: String(props.entries.length),
                category: props.category,
              },
            )}
            autocomplete="off"
            spellcheck="false"
          />
        </label>
      </Show>
      <For each={groups()} keyed={(group) => group.key}>
        {(group) => (
          <section class="chat-context__source">
            <Show when={group().group}>
              {(source) => (
                <div class="chat-context__source-heading" title={source().path}>
                  {t("chat.sessionDetails." + contextGroupLabelKeys[source().kind])}
                  <Show when={source().name}> · {source().name}</Show>
                </div>
              )}
            </Show>
            <ContextEntries entries={group().entries} group={group().group} />
          </section>
        )}
      </For>
      <Show when={groups().length === 0}>
        <p class="chat-context__no-matches">{t("common.multiSelect.noMatches")}</p>
      </Show>
      <Show when={long() && !all()}>
        <button
          type="button"
          class="chat-context__show-all"
          onClick={() => {
            setAll(true);
            onSettled(() => {
              search?.focus();
            });
          }}
        >
          {t("chat.sessionDetails.contextShowAll", { count: String(props.entries.length) })}
        </button>
      </Show>
    </div>
  );
}

function ContextInspector(props: {
  usage: Usage;
  categories: ContextCategory[];
  deferred: ContextGroup[];
  loading: boolean;
  refreshing: boolean;
  runActive: boolean;
  connected: boolean;
  compacting: boolean;
  canCompact: boolean;
  reserve?: number;
  onRefresh: () => void;
  onCompact: () => void;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
}) {
  const [open, setOpen] = createSignal<string | null>(null);
  let openButton: HTMLButtonElement | undefined;
  const [highlight, setHighlight] = createSignal<string | null>(null);
  let pendingHighlight: string | null = null;
  let activeHighlight: string | null = null;
  const highlightTimer = createTimeout(() => {
    activeHighlight = pendingHighlight;
    setHighlight(pendingHighlight);
  });
  const point = (id: string | null) => {
    pendingHighlight = id;
    highlightTimer.cancel();
    if (id && activeHighlight) {
      activeHighlight = id;
      setHighlight(id);
    } else {
      highlightTimer.schedule(id ? 60 : 140);
    }
  };
  const toggle = (id: string) => setOpen((current) => (current === id ? null : id));
  const deferredEntries = createMemo(() => props.deferred.flatMap((group) => group.entries));
  const rows = createMemo(() => [
    ...props.categories.map((category) => ({
      ...category,
      label: t("chat.sessionDetails." + contextLabelKeys[category.id]),
      deferred: false,
    })),
    ...(props.deferred.length || props.loading
      ? [
          {
            id: "deferred",
            tokens: null,
            entries: deferredEntries(),
            groups: props.deferred,
            label: t("chat.sessionDetails.contextAvailableOnDemand"),
            deferred: true,
          },
        ]
      : []),
  ]);
  const compact = formatCompactTokenCount;
  return (
    <div
      class={[
        "chat-context-page",
        "chat-context-panel__scroll",
        {
          "chat-context-page--loading": props.loading,
          "chat-context-page--highlight": highlight() !== null,
        },
      ]}
      ref={elementRef(props.onScrollPortRef)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open()) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(null);
          onSettled(() => {
            openButton?.focus();
          });
        }
      }}
      onPointerLeave={() => point(null)}
      onFocusOut={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          point(null);
        }
      }}
    >
      <header class="chat-context-page__header" onFocusIn={() => point(null)}>
        <div class="chat-context-page__title">
          <h2>
            {t(
              props.usage.fromLastPrompt
                ? "chat.composer.contextUsage.promptBudget"
                : "chat.composer.contextUsage.contextWindow",
            )}
          </h2>
          <button
            type="button"
            class="chat-context__refresh"
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            disabled={!props.connected || props.loading}
            onClick={() => props.onRefresh()}
          >
            <Icon
              name="refresh"
              class={props.refreshing ? "chat-context__refreshing" : undefined}
            />
          </button>
          <Show when={props.canCompact}>
            <button
              type="button"
              class={[
                "chat-context__compact",
                {
                  "chat-context__compact--high": props.usage.warning,
                },
              ]}
              disabled={!props.connected || props.compacting || props.loading || props.runActive}
              onClick={() => props.onCompact()}
              title={t("chat.sessionDetails.contextCompactDescription")}
            >
              <Show when={props.compacting}>
                <span class="btn__spinner" aria-hidden="true" />
              </Show>
              {t(
                props.compacting
                  ? "chat.sessionDetails.contextCompacting"
                  : "chat.sessionDetails.contextCompactShort",
              )}
            </button>
          </Show>
        </div>
        <div class="chat-context-page__numbers">
          <strong
            title={t("chat.sessionDetails.contextExactCount", {
              used: props.usage.used.toLocaleString(),
              limit: props.usage.limit.toLocaleString(),
            })}
          >
            {props.usage.approximate ? "~" : ""}
            {compact(props.usage.used)}
          </strong>
          <span>/ {compact(props.usage.limit)}</span>
          <span
            class={[
              "chat-context-page__percent",
              {
                "chat-context-page__percent--high": props.usage.warning,
              },
            ]}
          >
            {props.usage.approximate ? "~" : ""}
            {Math.min(100, Math.round((props.usage.used / props.usage.limit) * 1000) / 10)}%
          </span>
        </div>
        <div
          class="chat-context__bar"
          role="meter"
          aria-label={t("chat.sessionDetails.context")}
          aria-valuemin="0"
          aria-valuemax={props.usage.limit}
          aria-valuenow={Math.min(props.usage.used, props.usage.limit)}
          aria-valuetext={props.usage.detail}
        >
          <For each={props.categories} keyed={(category) => category.id}>
            {(category) => (
              <span
                class={[
                  "chat-context__segment",
                  `chat-context__${category().id}`,
                  { "chat-context__highlighted": highlight() === category().id },
                ]}
                style={{
                  width: Math.min(100, ((category().tokens ?? 0) / props.usage.limit) * 100) + "%",
                }}
                onPointerEnter={() => point(category().id)}
                onPointerLeave={() => point(null)}
              />
            )}
          </For>
        </div>
        <div class="chat-context-page__legend">
          <span>
            {t("chat.sessionDetails.contextFreeShort", {
              tokens:
                (props.usage.approximate ? "~" : "") +
                compact(Math.max(0, props.usage.limit - props.usage.used)),
            })}
          </span>
          <Show when={props.reserve !== undefined && !props.usage.approximate}>
            <span
              title={t("chat.sessionDetails.contextReserve", { tokens: compact(props.reserve!) })}
            >
              {t("chat.sessionDetails.contextReserveShort", { tokens: compact(props.reserve!) })}
            </span>
          </Show>
        </div>
        <Show when={props.usage.input !== null || props.usage.output !== null}>
          <div class="chat-context-page__latest">
            <span>{t("chat.composer.contextUsage.latestRun")}</span>
            <Show when={props.usage.input !== null}>
              <span>
                <b>{compact(props.usage.input!)}</b> {t("chat.sessionDetails.contextInputShort")}
              </span>
            </Show>
            <Show when={props.usage.input !== null && props.usage.output !== null}>
              <span>·</span>
            </Show>
            <Show when={props.usage.output !== null}>
              <span>
                <b>{compact(props.usage.output!)}</b> {t("chat.sessionDetails.contextOutputShort")}
              </span>
            </Show>
          </div>
        </Show>
      </header>
      <div class="chat-context-page__list">
        <For each={rows()} keyed={(row) => row.id}>
          {(row) => (
            <>
              <Show when={row().deferred}>
                <div class="chat-context-page__divider" />
              </Show>
              <button
                type="button"
                class={[
                  "chat-context__row",
                  {
                    "chat-context__highlighted": highlight() === row().id,
                    "chat-context__row--deferred": row().deferred,
                  },
                ]}
                data-context-category={row().id}
                data-context-details={row().deferred ? "deferred" : undefined}
                aria-expanded={
                  row().entries.length ? (open() === row().id ? "true" : "false") : undefined
                }
                disabled={props.loading || row().entries.length === 0}
                title={
                  row().deferred ? t("chat.sessionDetails.contextDeferredEstimate") : undefined
                }
                onClick={(event) => {
                  openButton = event.currentTarget;
                  toggle(row().id);
                }}
                onPointerEnter={() => point(row().deferred ? null : row().id)}
                onPointerLeave={() => point(null)}
                onFocus={() => point(row().deferred ? null : row().id)}
              >
                <span
                  class={["chat-context__swatch", `chat-context__${row().id}`]}
                  aria-hidden="true"
                />
                <span class="chat-context__label">
                  {row().label}
                  <Show when={row().entries.length > 0}>
                    <small>{row().entries.length}</small>
                  </Show>
                </span>
                <span class="chat-context__tokens">
                  {row().deferred ? "" : row().tokens === null ? "—" : compact(row().tokens!)}
                </span>
                <Show when={row().entries.length > 0}>
                  <Icon name="chevronRight" />
                </Show>
              </button>
              <Show when={open() === row().id && row().entries.length > 0}>
                <div data-context-section={row().id}>
                  <ContextList
                    entries={row().entries}
                    groups={row().groups}
                    category={row().label}
                    kind={row().id}
                  />
                </div>
              </Show>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

function ChatContextPage(props: {
  details: ContextPageDetails;
  presented: boolean;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
}) {
  const usage = createMemo(() => getContextNoticeViewModel(props.details.selectedSession));
  const [compacting, setCompacting] = createOptimistic(false);
  const compact = action(function* () {
    if (!props.presented || compacting() || props.details.runActive) {
      return;
    }
    setCompacting(true);
    yield props.details.onCompact?.();
  });
  return (
    <Show
      when={usage() && props.details.selectedSession && props.details.pullRequestsGateway}
      fallback={
        <ContextEmpty
          message={t(
            usage() ? "chat.sessionDetails.contextOffline" : "chat.sidePanel.contextEmpty",
          )}
        />
      }
    >
      <ChatContextReport
        gateway={props.details.pullRequestsGateway!}
        session={props.details.selectedSession!}
        agentId={props.details.currentAgentId ?? undefined}
        used={usage()!.used}
        presented={props.presented}
      >
        {(result, refresh) => {
          const categories = createMemo<ContextCategory[]>(() =>
            result().report
              ? buildChatContextCategories(result().report!, usage()!.used)
              : (["messages", "files", "tools", "skills", "system"] as const).map((id) => ({
                  id,
                  tokens: null,
                  entries: [],
                })),
          );
          const deferred = createMemo(() =>
            result().report ? buildDeferredContextGroups(result().report!) : [],
          );
          return (
            <Show
              when={result().report || result().loading}
              fallback={
                <ContextEmpty
                  message={t(
                    result().offline
                      ? "chat.sessionDetails.contextOffline"
                      : result().failed
                        ? "chat.sessionDetails.contextError"
                        : "chat.sessionDetails.contextUnavailable",
                  )}
                  onRetry={result().failed ? () => void refresh() : undefined}
                />
              }
            >
              <ContextInspector
                usage={usage()!}
                categories={categories()}
                deferred={deferred()}
                loading={result().loading && !result().report}
                refreshing={result().loading}
                runActive={Boolean(props.details.runActive)}
                connected={props.presented && !result().offline}
                compacting={compacting()}
                canCompact={Boolean(props.details.onCompact)}
                reserve={props.details.selectedSession?.contextBudgetStatus?.effectiveReserveTokens}
                onCompact={() => void compact()}
                onRefresh={() => void refresh()}
                onScrollPortRef={props.onScrollPortRef}
              />
            </Show>
          );
        }}
      </ChatContextReport>
    </Show>
  );
}

export type ChatContextPanelProps = {
  details?: ContextPageDetails;
  presented: boolean;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
};
export type ChatContextPanel = SolidBridgeElement<ChatContextPanelProps>;

export const ChatContextPanel = defineSolidBridge<ChatContextPanelProps>(
  "openclaw-chat-context-panel",
  (props) => {
    const details = createParkedProjection(
      () => (props.presented ? props.details : undefined),
      () => props.presented,
    );
    const identity = createMemo(() => {
      const session = details()?.selectedSession;
      return session && JSON.stringify([details()?.currentAgentId, session.key, session.sessionId]);
    });
    return (
      <div class="chat-context-panel">
        <Show
          when={identity()}
          keyed
          fallback={<ContextEmpty message={t("chat.sidePanel.contextEmpty")} />}
        >
          {(_identity) => (
            <Show when={details()}>
              {(current) => (
                <ChatContextPage
                  details={current()}
                  presented={props.presented}
                  onScrollPortRef={props.onScrollPortRef}
                />
              )}
            </Show>
          )}
        </Show>
      </div>
    );
  },
  {
    properties: {
      details: { default: undefined, attribute: false },
      presented: { default: false },
      onScrollPortRef: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-context-panel": ChatContextPanel;
  }
}
