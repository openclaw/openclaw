import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createStore, createUniqueId, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../../lib/reactive/pending-focus.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSessionRunStateActive } from "../../../lib/session-run-state.ts";
import { endedWithoutFinishing, isUnfinishedSubagent } from "../chat-spawned-subagent.ts";
import "../../../styles/session-panel-rail.css";
import "./chat-subagents-working.css";
import "./chat-subagents-panel-desktop.css";
import type { SubagentsPanelData, SubagentsPanelRow } from "../subagents-panel-data.ts";
import { SubagentDesktopAvatar } from "./chat-subagent-avatar.tsx";
import { ChatSubagentsNative } from "./chat-subagents-native.tsx";
import type { createSubagentsPresentation } from "./chat-subagents-presentation.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

type Group = "active" | "waiting" | "done" | "stopped" | "failed";
const groups: readonly Group[] = ["active", "waiting", "done", "stopped", "failed"];

function groupLabel(group: Group) {
  return t(
    group === "stopped"
      ? "chat.sessionDetails.stopped"
      : group === "failed"
        ? "common.failed"
        : `chat.subagentsPanel.desktopFilter.${group}`,
  );
}

export type ChatSubagentsPanelDesktopProps = {
  sessionKey: string;
  agentId: string;
  rows: readonly SubagentsPanelRow[];
  loading: boolean;
  emptyLoading?: boolean;
  error: string | null;
  hasResult: boolean;
  nativeSnapshot?: SubagentsPanelData["nativeSnapshot"];
  nativeError?: SubagentsPanelData["nativeError"];
  active: boolean;
  /** Whether Show more has revealed the complete Done list, not its disclosure. */
  doneExpanded?: boolean;
  onDoneExpandedChange?: (expanded: boolean) => void;
  onRefresh: () => void;
  createStop: ReturnType<typeof createSubagentsPresentation>["createStop"];
  onOpen: (row: SubagentsPanelRow) => void;
  renderElapsed: (row: SubagentsPanelRow) => JSX.Element;
};

function groupFor(row: SubagentsPanelRow): Group {
  if (row.session.status === "queued") {
    return "waiting";
  }
  return isSessionRunStateActive(row.session)
    ? "active"
    : isUnfinishedSubagent(row.session)
      ? "waiting"
      : (endedWithoutFinishing(row.session) ?? "done");
}

function DesktopRow(props: {
  row: SubagentsPanelRow;
  onOpen: (row: SubagentsPanelRow, source: HTMLButtonElement) => void;
  createStop: ReturnType<typeof createSubagentsPresentation>["createStop"];
  renderElapsed: ChatSubagentsPanelDesktopProps["renderElapsed"];
  registerOpen: (key: string, button: HTMLButtonElement) => () => void;
}) {
  const stop = props.createStop(() => props.row);
  const name = () => resolveSessionDisplayName(props.row.session.key, props.row.session);
  const group = () => groupFor(props.row);
  const ended = () => endedWithoutFinishing(props.row.session);
  const metadata = () =>
    [
      props.row.callCount &&
        t(
          !props.row.callCount.exact
            ? "chat.subagentsPanel.callsAtLeast"
            : props.row.callCount.count === 1
              ? "chat.subagentsPanel.callsOne"
              : "chat.subagentsPanel.callsMany",
          { count: String(props.row.callCount.count) },
        ),
      props.row.activity || props.row.toolDisplayName,
      ended() && t(ended() === "failed" ? "common.failed" : "chat.sessionDetails.stopped"),
    ]
      .filter(Boolean)
      .join(" · ");
  const stopLabel = () =>
    stop.stopping()
      ? t("chat.subagentsPanel.stopping")
      : t("chat.subagentsPanel.stop", { name: name() });
  return (
    <div
      class="subagents-desktop__row"
      data-session-key={props.row.session.key}
      data-group={group()}
      role="listitem"
    >
      <button
        class="subagents-desktop__open"
        ref={[elementRef(props.registerOpen.bind(undefined, props.row.session.key))]}
        type="button"
        title={[name(), metadata()].filter(Boolean).join("\n")}
        onClick={(event) => props.onOpen(props.row, event.currentTarget)}
      >
        <SubagentDesktopAvatar sessionKey={props.row.session.key} working={group() === "active"} />
        <span class="subagents-desktop__identity">
          <span ref={createTextOverflow(name)} class="subagents-desktop__name">
            {name()}
          </span>
          <Show when={group() !== "done"}>
            <span class="subagents-desktop__status">
              <Show
                when={group() === "active"}
                fallback={
                  group() === "waiting"
                    ? props.row.session.status === "queued"
                      ? t("common.queued")
                      : t("chat.subagentsPanel.desktopWaiting")
                    : groupLabel(group())
                }
              >
                <span class="subagents-desktop__working">
                  {t("chat.subagentsPanel.desktopWorking")}
                </span>{" "}
                <Show
                  when={props.row.session.runtimeMs != null || props.row.session.startedAt != null}
                >
                  <span>
                    {t("chat.subagentsPanel.desktopFor")} {props.renderElapsed(props.row)}
                  </span>
                </Show>
              </Show>
            </span>
          </Show>
          <span class="sr-only">{metadata()}</span>
        </span>
        <Show when={group() !== "active"}>
          <span class="subagents-desktop__elapsed" title={t("chat.subagentsPanel.duration")}>
            {props.renderElapsed(props.row)}
          </span>
        </Show>
        <Icon class="subagents-desktop__chevron" name="chevronRight" />
      </button>
      <Show
        when={
          isSessionRunStateActive(props.row.session) && props.row.session.activeRunIds?.length === 1
        }
      >
        <button
          class="subagents-desktop__stop"
          type="button"
          aria-label={stopLabel()}
          title={props.row.stopAccess.allowed ? stopLabel() : props.row.stopAccess.reason}
          disabled={stop.stopping() || !props.row.canStop}
          onClick={() => void stop.stop()}
        >
          <Icon name="stop" />
          <span>
            {stop.stopping() ? t("chat.subagentsPanel.stopping") : t("chat.runControls.stop")}
          </span>
        </button>
      </Show>
    </div>
  );
}

/** Retained by the panel owner while a child is open; execution remains in SubagentsPanelData. */
export function ChatSubagentsPanelDesktop(props: ChatSubagentsPanelDesktopProps) {
  const id = createUniqueId();
  const scope = createMemo(() => JSON.stringify([props.sessionKey, props.agentId]));
  // Disclosure/reveal and return targets belong to this session's local interaction state.
  const [navigation, setNavigation] = createStore<{
    scope: string;
    doneOpen: boolean;
    showAllDone: boolean;
    returnTarget?: { button: HTMLButtonElement; scrollTop: number };
  }>(
    (draft) => {
      const currentScope = scope();
      if (draft.scope !== currentScope) {
        draft.scope = currentScope;
        draft.doneOpen = true;
        draft.showAllDone = false;
        delete draft.returnTarget;
      }
    },
    { scope: "", doneOpen: true, showAllDone: false, returnTarget: undefined },
  );
  let content!: HTMLDivElement;
  const openButtons = new Map<string, HTMLButtonElement>();
  const registerOpen = (key: string, button: HTMLButtonElement) => {
    openButtons.set(key, button);
    return () => {
      if (openButtons.get(key) === button) {
        openButtons.delete(key);
      }
    };
  };
  createPendingFocus(
    () => {
      const target = navigation.returnTarget;
      // The focus callback consumes plain facts, not nested store reads.
      return {
        active: props.active,
        target: target && { button: target.button, scrollTop: target.scrollTop },
      };
    },
    {
      requested: (next) => Boolean(next.target),
      ready: (next) => next.active,
      focus: ({ target }) => {
        if (target) {
          content.scrollTop = target.scrollTop;
          // A child may disappear while open; retain a focus destination in the list.
          (target.button.isConnected ? target.button : content).focus({ preventScroll: true });
          setNavigation((draft) => {
            delete draft.returnTarget;
          });
        }
      },
    },
  );
  const allDone = () => props.doneExpanded ?? navigation.showAllDone;
  const visible = (group: Group) => props.rows.filter((row) => groupFor(row) === group);
  const shownGroups = createMemo(() => groups.filter((group) => visible(group).length > 0));
  const open = (row: SubagentsPanelRow, source: HTMLButtonElement) => {
    setNavigation((draft) => {
      draft.returnTarget = { button: source, scrollTop: content.scrollTop };
    });
    props.onOpen(row);
  };
  return (
    <div
      class="subagents-desktop"
      hidden={!props.active}
      aria-busy={props.loading ? "true" : "false"}
    >
      <div
        ref={(element) => {
          content = element;
        }}
        class="subagents-desktop__content"
        style={{ padding: props.emptyLoading ? "0" : undefined }}
        tabindex="-1"
      >
        <Show when={props.error}>
          <div class="chat-subagents__error" role="alert">
            <span>{props.error}</span>
            <button class="btn btn--sm" type="button" onClick={() => props.onRefresh()}>
              {t("common.retry")}
            </button>
          </div>
        </Show>
        <ChatSubagentsNative snapshot={props.nativeSnapshot} error={props.nativeError ?? null} />
        <Show
          when={props.rows.length}
          fallback={
            !props.nativeSnapshot &&
            !props.nativeError &&
            (props.loading || (props.hasResult && !props.error)) && (
              <Show
                when={props.loading}
                fallback={
                  <PanelEmptyState
                    presentation="desktop"
                    icon={<Icon name="bot" />}
                    heading={t("chat.sidePanel.subagents")}
                    description={t("chat.subagentsPanel.empty")}
                  />
                }
              >
                <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} />
              </Show>
            )
          }
        >
          <For each={shownGroups()} keyed={(group) => group}>
            {(group) => (
              <section class="subagents-desktop__group" aria-label={groupLabel(group())}>
                <Show
                  when={group() === "done"}
                  fallback={
                    <h3 class="subagents-desktop__heading">
                      <span>{groupLabel(group())}</span>
                      <span class="subagents-desktop__count">{visible(group()).length}</span>
                    </h3>
                  }
                >
                  <button
                    class="subagents-desktop__heading subagents-desktop__disclosure"
                    type="button"
                    aria-expanded={navigation.doneOpen ? "true" : "false"}
                    aria-controls={`${id}-done`}
                    onClick={() =>
                      setNavigation((draft) => {
                        draft.doneOpen = !draft.doneOpen;
                      })
                    }
                  >
                    <span>{t("chat.subagentsPanel.desktopFilter.done")}</span>
                    <span class="subagents-desktop__count">{visible("done").length}</span>
                    <Icon name={navigation.doneOpen ? "chevronDown" : "chevronRight"} />
                  </button>
                </Show>
                <Show when={group() !== "done" || navigation.doneOpen}>
                  <div id={group() === "done" ? `${id}-done` : undefined} role="list">
                    <For
                      each={
                        group() === "done" && !allDone()
                          ? visible("done").slice(0, 10)
                          : visible(group())
                      }
                      keyed={(row) => row.session.key}
                    >
                      {(row) => (
                        <DesktopRow
                          row={row()}
                          onOpen={open}
                          createStop={props.createStop}
                          renderElapsed={props.renderElapsed}
                          registerOpen={registerOpen}
                        />
                      )}
                    </For>
                  </div>
                  <Show when={group() === "done" && !allDone() && visible("done").length > 10}>
                    <button
                      class="subagents-desktop__more"
                      type="button"
                      onClick={() => {
                        const key = visible("done")[10]?.session.key;
                        const currentScope = scope();
                        setNavigation((draft) => {
                          draft.showAllDone = true;
                        });
                        props.onDoneExpandedChange?.(true);
                        onSettled(() => {
                          const button = key ? openButtons.get(key) : undefined;
                          if (scope() === currentScope && props.active && button?.isConnected) {
                            button.focus({ preventScroll: true });
                          }
                        });
                      }}
                    >
                      {t("chat.subagentsPanel.desktopShowMore")}
                    </button>
                  </Show>
                </Show>
              </section>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
