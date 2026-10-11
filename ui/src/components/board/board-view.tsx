import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import {
  BOARD_GRID_COLUMNS,
  BOARD_DOCUMENT_AUTO_MAX_ROWS,
  boardWidgetGridItems,
  FINE_POINTER_QUERY,
  layout,
} from "../../lib/board/grid.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import "../../styles/board.css";
import "../web-awesome-tabs.ts";
import "../web-awesome.ts";
import { BoardTabs, orderedBoardTabs } from "./board-tabs.tsx";
import {
  BoardViewState,
  orderedWidgets,
  type BoardViewProps,
  type BoardViewMethods,
  type BoardViewElement,
} from "./board-view-state.ts";
import { BoardWidgetCell, type BoardWidgetCellProps } from "./board-widget-cell.ts";

export type { BoardViewProps } from "./board-view-state.ts";

const views = new WeakMap<HTMLElement, BoardViewState>();
type CellEntry = {
  key: string;
  present: boolean;
  retiring?: boolean;
  element?: Pick<
    HTMLElementTagNameMap["openclaw-board-widget-cell"],
    "teardown" | "restartAfterTeardown"
  >;
  options: BoardWidgetCellProps;
};

function BoardViewContent(props: BoardViewProps, host: BoardViewElement) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new BoardViewState(props, host, () => setRevision((value) => value + 1));
  views.set(host, state);
  // Grid coordinates change; map insertion order keeps iframe nodes in place.
  const entries = new Map<string, CellEntry>();
  let disposed = false;
  const cellKey = (name: string) =>
    JSON.stringify([
      props.session.agentId,
      props.session.sessionKey,
      props.snapshot?.sessionKey,
      name,
    ]);
  const view = createMemo(() => {
    revision();
    state.sync();
    const snapshot = props.snapshot;
    const tabs = orderedBoardTabs(snapshot?.tabs ?? []);
    const activeTab = state.activeTab(tabs);
    const activeTabId = activeTab?.tabId ?? props.activeTabId;
    const activeWidgets = snapshot && activeTab ? orderedWidgets(snapshot, activeTabId) : [];
    if (activeTab) {
      state.visitedTabs.add(activeTabId);
    }
    // A widget moved to an unvisited tab keeps its already mounted document.
    const widgets = (snapshot?.widgets ?? []).filter(
      (widget) => state.visitedTabs.has(widget.tabId) || entries.has(cellKey(widget.name)),
    );
    const rects = tabs.flatMap((tab) =>
      layout(
        (tab.tabId === activeTabId ? state.previewItems : null) ??
          boardWidgetGridItems(
            widgets.filter((widget) => widget.tabId === tab.tabId),
            state.contentHeights,
            props.fitAutoContent,
            props.pageWidgetName,
          ),
        props.fitAutoContent ? BOARD_DOCUMENT_AUTO_MAX_ROWS : undefined,
      ),
    );
    const activeNames = new Set(activeWidgets.map((widget) => widget.name));
    const activeRects = rects.filter((rect) => activeNames.has(rect.name));
    const fullWidth = activeWidgets.length === 1 && activeWidgets[0]?.sizeW === BOARD_GRID_COLUMNS;
    const page =
      fullWidth &&
      (activeWidgets[0]?.name === props.pageWidgetName ||
        activeWidgets[0]?.pluginKind === "session:website" ||
        activeWidgets[0]?.pluginKind === "browser:dashboard");
    const loading = !snapshot || state.initialLoading;
    const widgetsByName = new Map(widgets.map((widget) => [widget.name, widget]));
    const positions = new Map(activeRects.map((rect, index) => [rect.name, index]));
    const focusName = activeRects.some((rect) => rect.name === state.focusName)
      ? state.focusName
      : (activeRects[0]?.name ?? "");
    for (const entry of entries.values()) {
      entry.present = false;
    }
    for (const rect of rects) {
      const key = cellKey(rect.name);
      const visible = activeNames.has(rect.name);
      entries.set(key, {
        ...entries.get(key),
        key,
        present: true,
        options: {
          widget: widgetsByName.get(rect.name),
          rect,
          contentHeightPx: state.contentHeights.get(rect.name),
          fitAutoContent: props.fitAutoContent,
          pageChrome: rect.name === props.pageWidgetName,
          tabs,
          session: props.session,
          sessionKey: snapshot?.sessionKey ?? "",
          widgetFrameUrl: props.widgetFrameUrl,
          callbacks: state.cellCallbacks,
          active: props.active && visible,
          bridgeEnabled: props.bridgeEnabled,
          dragging: rect.name === state.gestureName,
          focusTabIndex: rect.name === focusName ? 0 : -1,
          positionInSet: (positions.get(rect.name) ?? 0) + 1,
          setSize: activeRects.length,
          busy: state.mutationPending,
          canMutate: props.canMutate,
          canGrant: props.canGrant,
          loadingCovered: loading,
        },
      });
    }
    for (const [key, entry] of entries) {
      if (entry.present) {
        continue;
      }
      if (entry.options.widget?.contentKind !== "mcp-app" || !entry.element) {
        entries.delete(key);
      } else if (!entry.retiring) {
        // Keep the last binding connected until the app's bounded teardown completes.
        entries.set(key, {
          ...entry,
          retiring: true,
          options: { ...entry.options, active: false },
        });
        const element = entry.element;
        const finish = () => {
          if (disposed) {
            return;
          }
          const current = entries.get(key);
          if (current?.present) {
            current.retiring = false;
            element.restartAfterTeardown();
          } else {
            entries.delete(key);
          }
          state.requestUpdate();
        };
        void element.teardown().then(finish, finish);
      }
    }
    return {
      tabs,
      activeTabId,
      activeNames,
      empty: activeRects.length === 0,
      fullWidth,
      page,
      loading,
      cells: [...entries.values()],
      state,
    };
  });
  createEffect(
    () => view(),
    (current) => {
      host.toggleAttribute("data-initial-loading", current.loading);
      state.reconcileInitialPresentation();
    },
  );
  onSettled(() => {
    // Hybrid devices move the chrome in/out of flow when pointer capability changes.
    const pointer =
      typeof window.matchMedia === "function" ? window.matchMedia(FINE_POINTER_QUERY) : null;
    pointer?.addEventListener("change", state.requestUpdate);
    return () => pointer?.removeEventListener("change", state.requestUpdate);
  });
  onCleanup(() => {
    disposed = true;
    state.disconnect();
    views.delete(host);
  });

  return (
    <>
      <Show when={view().loading}>
        <PanelLoadingSkeleton
          variant="board"
          label={t("common.loading")}
          compact={false}
          overlay={true}
        />
      </Show>
      <section
        class={[
          "board-view",
          {
            "board-view--single-full-width": view().fullWidth,
            "board-view--page": view().page,
            "board-view--loading": view().loading,
          },
        ]}
        aria-label={t("board.label")}
        aria-busy={view().loading ? "true" : "false"}
        inert={view().loading}
        onOpenclaw-board-widget-presentation={state.reconcileInitialPresentation}
      >
        <BoardTabs
          tabs={view().tabs}
          activeTabId={view().activeTabId}
          hoverTabId={view().state.hoverTabId}
          onTabShow={state.handleTabShow}
          onOverflowSelect={state.handleOverflowSelect}
        />
        <Show when={Boolean(props.snapshot) || view().cells.length > 0}>
          <div
            class="board-grid"
            role="list"
            aria-label={t("board.gridLabel")}
            hidden={view().empty}
          >
            <For each={view().cells} keyed={(entry) => entry.key}>
              {(entry) => (
                <BoardWidgetCell
                  {...entry().options}
                  ref={(element) => {
                    const current = entries.get(entry().key);
                    if (current) {
                      current.element = element;
                    }
                  }}
                  hidden={!entry().present || !view().activeNames.has(entry().options.widget!.name)}
                  inert={!entry().present || !view().activeNames.has(entry().options.widget!.name)}
                />
              )}
            </For>
            <Show when={view().state.gesture?.mode === "move"}>
              <div class="board-grid__append-zone" aria-hidden="true" />
            </Show>
          </div>
          <Show when={view().empty}>
            <div class="board-empty" data-test-id="board-empty">
              <span class="board-empty__mark" aria-hidden="true">
                ＋
              </span>
              <strong>{t("board.emptyTitle")}</strong>
              <span>{t("board.emptyHint")}</span>
            </div>
          </Show>
        </Show>
        <Show when={view().state.actionError}>
          <div class="board-view__error" role="alert">
            {view().state.actionError}
          </div>
        </Show>
        <div class="board-announcer" aria-live="polite" aria-atomic="true">
          <Show when={view().state.announcementRevision || undefined} keyed>
            {(announcementRevision) => (
              <span data-announcement-revision={announcementRevision}>
                {view().state.announcement}
              </span>
            )}
          </Show>
        </div>
      </section>
    </>
  );
}

export const BoardView = defineSolidBridge<BoardViewProps, BoardViewMethods>(
  "openclaw-board-view",
  BoardViewContent,
  {
    properties: {
      session: { default: { sessionKey: "" }, attribute: false },
      snapshot: { default: undefined, attribute: false },
      activeTabId: { default: "", attribute: false },
      widgetFrameUrl: { default: undefined, attribute: false },
      callbacks: { default: undefined, attribute: false },
      active: { default: true, type: Boolean },
      bridgeEnabled: { default: true, type: Boolean },
      canMutate: { default: true, type: Boolean },
      canGrant: { default: true, type: Boolean },
      fitAutoContent: { default: false, type: Boolean },
      pageWidgetName: { default: "", attribute: false },
    },
    methods: {
      selectPageWidgetMenuItem: (
        host: BoardViewElement,
        name: string,
        revision: number,
        value: string,
      ) => views.get(host)?.selectPageWidgetMenuItem(name, revision, value),
      teardown: async (host: BoardViewElement) => {
        await views.get(host)?.teardown();
      },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-view": BoardViewElement;
  }
}

type BoardViewAttributes = SolidJSX.HTMLAttributes<BoardViewElement> & {
  [Key in keyof BoardViewProps as `prop:${Key}`]?: BoardViewProps[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-board-view": BoardViewAttributes;
    }
  }
}
