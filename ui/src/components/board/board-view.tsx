import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, Errored, For, onSettled, Show } from "solid-js";
import { registerBoardDocumentEnglish } from "../../i18n/locales/en-board-document.ts";
import { BOARD_GRID_COLUMNS } from "../../lib/board/grid-constants.ts";
import {
  BOARD_DOCUMENT_AUTO_MAX_ROWS,
  boardWidgetGridItems,
  FINE_POINTER_QUERY,
  layout,
} from "../../lib/board/grid.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import "../../styles/board.css";
import { BoardTabs } from "./board-tabs.tsx";
import {
  createBoardViewState,
  orderedWidgets,
  type BoardViewProps,
  type BoardViewMethods,
  type BoardViewElement,
} from "./board-view-state.ts";
import type { BoardWidgetCellMethods, BoardWidgetCellProps } from "./board-widget-cell-options.ts";
import { BoardWidgetCell } from "./board-widget-cell.solid.tsx";

registerEnglishCatalog(registerBoardDocumentEnglish);

export type { BoardViewProps } from "./board-view-state.ts";

const views = new WeakMap<HTMLElement, ReturnType<typeof createBoardViewState>>();
type CellEntry = {
  key: string;
  present: boolean;
  retiring?: boolean;
  element?: SolidBridgeElement<BoardWidgetCellProps, BoardWidgetCellMethods>;
  options: BoardWidgetCellProps;
};

function BoardViewContent(props: BoardViewProps, host: BoardViewElement) {
  const [layoutRevision, setLayoutRevision] = createSignal(0, { ownedWrite: true });
  const invalidateLayout = () => setLayoutRevision((value) => value + 1);
  // Grid coordinates change; map insertion order keeps iframe nodes in place.
  const entries = new Map<string, CellEntry>();
  const owner = createBoardViewState(props, host, () =>
    [...entries.values()].flatMap(({ element }) => (element ? [element] : [])),
  );
  views.set(host, owner);
  let disposed = false;
  const cellKey = (name: string) =>
    JSON.stringify([
      props.session.agentId,
      props.session.sessionKey,
      props.snapshot?.sessionKey,
      name,
    ]);
  const view = createMemo(() => {
    layoutRevision();
    const state = owner.presentation;
    const snapshot = props.snapshot;
    const tabs = owner.tabs();
    const activeTab = owner.activeTab();
    const activeTabId = activeTab?.tabId ?? props.activeTabId;
    const activeWidgets = snapshot && activeTab ? orderedWidgets(snapshot, activeTabId) : [];
    if (activeTab) {
      owner.visitedTabs.add(activeTabId);
    }
    // A widget moved to an unvisited tab keeps its already mounted document.
    const widgets = (snapshot?.widgets ?? []).filter(
      (widget) => owner.visitedTabs.has(widget.tabId) || entries.has(cellKey(widget.name)),
    );
    const positions = new Map<string, number>();
    const rects = tabs.flatMap((tab) => {
      const tabRects = layout(
        (tab.tabId === activeTabId && state.gesture.name ? state.previewItems : null) ??
          boardWidgetGridItems(
            widgets.filter((widget) => widget.tabId === tab.tabId),
            owner.contentHeights,
            props.fitAutoContent,
            props.pageWidgetName,
          ),
        props.fitAutoContent ? BOARD_DOCUMENT_AUTO_MAX_ROWS : undefined,
      );
      tabRects.forEach((rect, index) => positions.set(rect.name, index));
      return tabRects;
    });
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
    const focusName = activeRects.some((rect) => rect.name === state.focusName)
      ? state.focusName
      : (activeRects[0]?.name ?? "");
    for (const entry of entries.values()) {
      entry.present = false;
    }
    for (const rect of rects) {
      const key = cellKey(rect.name);
      const visible = activeNames.has(rect.name);
      const previous = entries.get(key);
      const previousRect = previous?.options.rect;
      // Equal geometry must not invalidate every retained card on a tab switch.
      const stableRect =
        previousRect &&
        previousRect.x === rect.x &&
        previousRect.y === rect.y &&
        previousRect.w === rect.w &&
        previousRect.h === rect.h
          ? previousRect
          : rect;
      entries.set(key, {
        ...previous,
        key,
        present: true,
        options: {
          widget: widgetsByName.get(rect.name),
          boardRevision: snapshot?.revision ?? 0,
          rect: stableRect,
          contentHeightPx: owner.contentHeights.get(rect.name),
          fitAutoContent: props.fitAutoContent,
          pageChrome: rect.name === props.pageWidgetName,
          tabs,
          session: props.session,
          sessionKey: snapshot?.sessionKey ?? "",
          widgetFrameUrl: props.widgetFrameUrl,
          callbacks: owner.cellCallbacks,
          active: props.active && visible,
          bridgeEnabled: props.bridgeEnabled,
          dragging: rect.name === state.gesture.name,
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
          invalidateLayout();
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
      owner.reconcileInitialPresentation();
    },
  );
  onSettled(() => {
    // Hybrid devices move the chrome in/out of flow when pointer capability changes.
    const pointer =
      typeof window.matchMedia === "function" ? window.matchMedia(FINE_POINTER_QUERY) : null;
    const stop = pointer ? listen(pointer, "change", invalidateLayout) : undefined;
    return () => {
      disposed = true;
      views.delete(host);
      stop?.();
    };
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
      >
        <BoardTabs
          tabs={view().tabs}
          activeTabId={view().activeTabId}
          hoverTabId={view().state.hoverTabId}
          onSelect={owner.selectTab}
        />
        <Show when={Boolean(props.snapshot) || view().cells.length > 0}>
          <div
            ref={owner.gridRef}
            class="board-grid"
            role="list"
            aria-label={t("board.gridLabel")}
            hidden={view().empty}
          >
            <For each={view().cells} keyed={(entry) => entry.key}>
              {(entry) => {
                const cellRef = (element: NonNullable<CellEntry["element"]>) => {
                  const current = entries.get(entry().key);
                  if (current) {
                    current.element = element;
                  }
                };
                // One reactive object avoids retaining a getter for every field on every card.
                return (
                  <BoardWidgetCell
                    {...{
                      ...entry().options,
                      ref: cellRef,
                      hidden:
                        !entry().present || !view().activeNames.has(entry().options.widget!.name),
                      inert:
                        !entry().present || !view().activeNames.has(entry().options.widget!.name),
                    }}
                  />
                );
              }}
            </For>
            <Show when={view().state.gesture.mode === "move"}>
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
        <Show when={view().state.mutationFailure} keyed>
          <Errored
            fallback={() => (
              <div class="board-view__error" role="alert">
                {t("board.actionFailed")}
              </div>
            )}
          >
            {owner.mutationFailure()}
          </Errored>
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
