import { expectDefined } from "@openclaw/normalization-core";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import "../../components/resizable-divider.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import type { DropIndicator } from "./chat-page-drop-indicator.ts";
import type { PaneSessionChangeOptions } from "./chat-pane-shared.ts";
import { ChatPaneView } from "./chat-pane.tsx";
import type { RouteDraftComposerFocus } from "./route-draft-focus-handoff.ts";
import { routeDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { ChatSplitLayout, ChatSplitColumn, ChatSplitPane } from "./split-layout-types.ts";
import { findPane, splitRatio } from "./split-layout.ts";

// The route loader loads this bridge only for pending creation; ordinary Chat stays lazy.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-pending-session-create": HTMLAttributes<HTMLElement> & {
        "prop:context": ApplicationContext | undefined;
        "prop:sessionKey": string;
        "prop:narrow": boolean;
        "prop:mergedChrome": boolean;
        "prop:navDrawerOpen": boolean;
      };
    }
  }
}

type ChatPagePaneRenderOptions = {
  active: boolean;
  presented: boolean;
  chatMessagesBySession: ChatMessageCache;
  sessionSnapshotStore: SessionSnapshotStore;
  consumedDraftData: SessionChatRouteData | null;
  context?: ApplicationContext;
  data?: SessionChatRouteData;
  draftFocus: RouteDraftComposerFocus;
  mergedChrome: boolean;
  narrow: boolean;
  navDrawerOpen: boolean;
  onboarding: boolean;
  onClosePane?: (paneId: string) => void;
  onFaceChange: (paneId: string, sessionKey: string, face: BoardFace) => void;
  onFocusPane: (paneId: string, intent?: "review-edit") => void;
  onOpenSplitView?: () => void;
  onPaneSessionChange: (
    paneId: string,
    sourceSessionKey: string,
    sessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean;
  onSessionDeleted: (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
    preserveDraft?: boolean,
  ) => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  ownerKey: string;
  pane: ChatSplitPane;
  panePosition: { column: number; row: number };
  sessionSlots: readonly (string | undefined)[];
  splitMode: boolean;
  unbound: boolean;
  weight: number;
};

export function chatPagePaneOwnerKeys(
  context: ApplicationContext | undefined,
  layout: ChatSplitLayout,
  retainedSessions: ReadonlyMap<string, readonly (string | undefined)[]>,
): Set<string> {
  const nextPaneKeys = new Set<string>();
  for (const column of layout.columns) {
    for (const pane of column.panes) {
      const ownerKey = JSON.stringify([column.id, pane.id]);
      for (const sessionKey of retainedSessions.get(pane.id) ?? []) {
        if (
          sessionKey !== undefined &&
          (!context || !readDeletedSessionStartup(context, sessionKey))
        ) {
          nextPaneKeys.add(JSON.stringify([ownerKey, sessionKey]));
        }
      }
    }
  }
  return nextPaneKeys;
}

type SplitRenderOptions = {
  pane: Omit<
    ChatPagePaneRenderOptions,
    "active" | "ownerKey" | "pane" | "panePosition" | "sessionSlots" | "unbound" | "weight"
  >;
  retainedSessions: ReadonlyMap<string, readonly (string | undefined)[]>;
  unboundPaneIds?: ReadonlySet<string>;
  onResizePanes: (columnId: string, paneIndex: number, ratio: number) => void;
  onResizeColumns: (columnIndex: number, ratio: number) => void;
  onResizeEnd: () => void;
};
export function createChatPageSnapshot(
  layout: ChatSplitLayout,
  options: SplitRenderOptions,
  indicator: DropIndicator | null,
) {
  const cells = new Map(
    layout.columns.flatMap((column, columnIndex) =>
      column.panes.map(
        (pane, paneIndex) =>
          [
            pane.id,
            {
              ...options.pane,
              active: options.pane.presented && pane.id === layout.activePaneId,
              ownerKey: JSON.stringify([column.id, pane.id]),
              pane,
              panePosition: { column: columnIndex + 1, row: paneIndex + 1 },
              sessionSlots: options.retainedSessions.get(pane.id) ?? [],
              unbound: options.unboundPaneIds?.has(pane.id) ?? false,
              weight: expectDefined(column.paneWeights[paneIndex], "rendered split pane weight"),
            },
          ] as const,
      ),
    ),
  );
  return { layout, options, cells, indicator };
}
export type ChatPageSnapshot = ReturnType<typeof createChatPageSnapshot>;

function ChatPageSession(props: { options: ChatPagePaneRenderOptions; sessionKey: string }) {
  const visible = () =>
    props.sessionKey === props.options.pane.sessionKey ||
    areUiSessionKeysEquivalent(props.sessionKey, props.options.pane.sessionKey);
  const presented = () =>
    props.options.presented && visible() && (!props.options.narrow || props.options.active);
  const active = () => props.options.active && visible();
  const routeData = () =>
    props.options.data &&
    areUiSessionKeysEquivalent(props.sessionKey, props.options.data.sessionKey)
      ? props.options.data
      : undefined;
  // Hidden retained panes keep the last route presentation.
  const retainedRoute = createMemo<SessionChatRouteData | undefined>(
    (previous) => routeData() ?? previous,
  );
  // Canonicalization can omit the initial loading flag before this pane's startup settles.
  const routeLoadingSkeleton = createMemo<boolean>(
    (previous) => routeData()?.routeLoadingSkeleton ?? previous ?? false,
  );
  const draft = () =>
    active()
      ? routeDraft(props.options.data, props.options.consumedDraftData, props.sessionKey)
      : undefined;
  const presentationTitle = () => {
    const context = props.options.context;
    const resolved =
      resolveSessionKey(props.sessionKey, context?.gateway?.snapshot?.hello) || props.sessionKey;
    const row = context?.sessions?.presentation.result?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, resolved),
    );
    return row ? resolveSessionDisplayName(resolved, row) : undefined;
  };
  const pending = () =>
    props.options.context &&
    (routeData()?.creation?.admitted === false ||
      readDeletedSessionStartup(props.options.context, props.sessionKey));
  const className = () =>
    [
      "chat-pane-cache__pane",
      visible() ? "chat-pane-cache__pane--visible" : "",
      active() ? "chat-pane-cache__pane--active" : "",
      props.options.splitMode ? "chat-split-view__pane" : "",
    ]
      .filter(Boolean)
      .join(" ");
  return (
    <Show
      when={!pending()}
      fallback={
        <openclaw-pending-session-create
          class={className()}
          aria-hidden={presented() ? "false" : "true"}
          inert={!presented()}
          prop:context={props.options.context}
          prop:sessionKey={props.sessionKey}
          prop:narrow={props.options.narrow}
          prop:mergedChrome={props.options.mergedChrome && active()}
          prop:navDrawerOpen={props.options.navDrawerOpen && active()}
        />
      }
    >
      <ChatPaneView
        class={className()}
        data-mcp-app-owner-key={JSON.stringify([props.options.ownerKey, props.sessionKey])}
        aria-hidden={presented() ? "false" : "true"}
        inert={!presented()}
        paneId={props.options.pane.id}
        paneLabel={t("chat.splitView.panePosition", {
          column: String(props.options.panePosition.column),
          row: String(props.options.panePosition.row),
          pane: props.options.pane.id,
        })}
        presentationId={JSON.stringify([props.options.pane.id, props.sessionKey])}
        chatMessagesBySession={props.options.chatMessagesBySession}
        sessionSnapshotStore={props.options.sessionSnapshotStore}
        sessionKey={props.sessionKey}
        agentId={
          props.options.splitMode ? parseAgentSessionKey(props.sessionKey)?.agentId : undefined
        }
        routeLoadingSkeleton={routeLoadingSkeleton()}
        presented={presented()}
        visuallyPresented={presented()}
        active={active()}
        draft={draft()}
        focusComposer={props.options.draftFocus.shouldFocusPane(
          active(),
          draft(),
          props.sessionKey,
          props.options.data,
        )}
        dashboardExpanded={retainedRoute()?.dashboardExpanded === true}
        routeFace={retainedRoute()?.face}
        presentationTitle={presentationTitle()}
        narrow={props.options.narrow}
        mergedChrome={props.options.mergedChrome && active()}
        navDrawerOpen={props.options.navDrawerOpen && active()}
        onboarding={props.options.onboarding}
        onOpenSplitView={props.options.onOpenSplitView}
        onSplitDown={props.options.onSplitDown}
        onSplitRight={props.options.onSplitRight}
        onClosePane={props.options.onClosePane}
        onFocusPane={props.options.onFocusPane}
        onPaneSessionChange={(paneId: string, next: string, options?: PaneSessionChangeOptions) =>
          props.options.onPaneSessionChange(paneId, props.sessionKey, next, options)
        }
        onSessionDeleted={props.options.onSessionDeleted}
        onFaceChange={props.options.onFaceChange}
      />
    </Show>
  );
}

function ChatPagePaneCell(props: { options: ChatPagePaneRenderOptions }) {
  return (
    <div
      class={[
        "chat-split-view__cell",
        {
          "chat-split-view__cell--active": props.options.splitMode && props.options.active,
          "chat-split-view__cell--narrow-hidden": props.options.narrow && !props.options.active,
        },
      ]}
      aria-current={props.options.splitMode && props.options.active ? "true" : undefined}
      style={{ flex: `${props.options.narrow ? 1 : props.options.weight} 1 0` }}
      onPointerDown={() => props.options.onFocusPane(props.options.pane.id)}
      onFocusIn={() => props.options.onFocusPane(props.options.pane.id)}
    >
      <div class="chat-pane-cache">
        <Show when={props.options.unbound}>
          <div
            class="chat-split-view__unbound"
            data-unbound-pane-id={props.options.pane.id}
            tabindex={0}
            role="region"
            aria-label={t("chat.splitView.chooseConversation")}
          >
            <strong>{t("chat.splitView.chooseConversation")}</strong>
            <p>{t("chat.splitView.missingOwner")}</p>
            <Show when={props.options.onClosePane}>
              <button
                class="btn"
                onClick={() => props.options.onClosePane?.(props.options.pane.id)}
              >
                {t("chat.splitView.closePane")}
              </button>
            </Show>
          </div>
        </Show>
        <For each={props.options.sessionSlots} keyed={false}>
          {(session) => (
            <For each={session() !== undefined && !props.options.unbound ? [session()!] : []}>
              {(sessionKey) => <ChatPageSession options={props.options} sessionKey={sessionKey} />}
            </For>
          )}
        </For>
      </div>
    </div>
  );
}

function SplitDivider(props: {
  index: number;
  column?: ChatSplitColumn;
  layout: ChatSplitLayout;
  options: SplitRenderOptions;
}): SolidJSX.Element {
  return (
    <resizable-divider
      prop:orientation={props.column ? "horizontal" : "vertical"}
      prop:splitRatio={splitRatio(
        props.column?.paneWeights ?? props.layout.columnWeights,
        props.index,
        props.column ? "split pane weight" : "split column weight",
      )}
      prop:minRatio={0.15}
      prop:maxRatio={0.85}
      prop:label={t("nav.resize")}
      onResize={(event) =>
        props.column
          ? props.options.onResizePanes(props.column.id, props.index, event.detail.splitRatio)
          : props.options.onResizeColumns(props.index, event.detail.splitRatio)
      }
      onResize-end={() => props.options.onResizeEnd()}
    />
  );
}

function SplitLayout(props: { snapshot: ChatPageSnapshot }) {
  const layout = () => props.snapshot.layout;
  const options = () => props.snapshot.options;
  return (
    <div
      class={[
        "chat-split-view",
        {
          "chat-split-view--narrow": options().pane.narrow,
          "chat-split-view--active-cell":
            options().pane.splitMode &&
            options().pane.presented &&
            findPane(layout(), layout().activePaneId) !== null,
        },
      ]}
    >
      <For each={layout().columns} keyed={(column) => column.id}>
        {(column, columnIndex) => (
          <>
            <div
              class={[
                "chat-split-view__column",
                {
                  "chat-split-view__column--narrow-hidden":
                    options().pane.narrow &&
                    !column().panes.some((pane) => pane.id === layout().activePaneId),
                },
              ]}
              style={{
                flex: `${options().pane.narrow ? 1 : expectDefined(layout().columnWeights[columnIndex()], "rendered split column weight")} 1 0`,
              }}
            >
              <For each={column().panes} keyed={(pane) => pane.id}>
                {(pane, paneIndex) => (
                  <>
                    <ChatPagePaneCell
                      options={expectDefined(
                        props.snapshot.cells.get(pane().id),
                        "rendered split pane",
                      )}
                    />
                    <Show when={!options().pane.narrow && paneIndex() < column().panes.length - 1}>
                      <SplitDivider
                        index={paneIndex()}
                        column={column()}
                        layout={layout()}
                        options={options()}
                      />
                    </Show>
                  </>
                )}
              </For>
            </div>
            <Show when={!options().pane.narrow && columnIndex() < layout().columns.length - 1}>
              <SplitDivider index={columnIndex()} layout={layout()} options={options()} />
            </Show>
          </>
        )}
      </For>
    </div>
  );
}

export function ChatPageBody(props: { snapshot: ChatPageSnapshot | null }) {
  return (
    <Show when={props.snapshot}>
      {(snapshot) => (
        <div class="chat-split-view__drop-container">
          <SplitLayout snapshot={snapshot()} />
          <Show when={snapshot().indicator}>
            {(indicator) => (
              <div
                class={[
                  "chat-split-view__drop-indicator",
                  { "chat-split-view__drop-indicator--center": indicator().zone.kind === "center" },
                ]}
                style={{
                  left: `${indicator().rect.left}px`,
                  top: `${indicator().rect.top}px`,
                  width: `${indicator().rect.width}px`,
                  height: `${indicator().rect.height}px`,
                }}
              >
                <span class="chat-split-view__drop-indicator-label">
                  {indicator().zone.kind === "center"
                    ? t("chat.splitView.dropOpenHere")
                    : t("chat.splitView.dropSplit")}
                </span>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
