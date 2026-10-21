import type { BoardCommand, BoardCommandEvent, BoardSnapshot } from "@openclaw/gateway-protocol";
import { t } from "../i18n/index.ts";
import { normalizeBoardWidgetTitle } from "../lib/board/provider-helpers.ts";
import { EventStream, ValueSignal } from "../lib/board/provider-signals.ts";
import type {
  BoardPinMcpAppInput,
  BoardPinWidgetInput,
  BoardProvider,
} from "../lib/board/provider-types.ts";
import type { BoardWidgetAppViewState } from "../lib/board/view-types.ts";
import {
  canvasWidgetNameForDocument,
  mcpAppWidgetNameForViewId,
} from "../lib/board/widget-names.ts";
import { normalizeDefaultMainSessionAliasForUi } from "../lib/sessions/session-key.ts";
import { applyMockBoardOp, normalizeMockBoardSnapshot } from "./board-ops.ts";

function mockSnapshot(sessionKey: string): BoardSnapshot {
  return {
    sessionKey,
    revision: 1,
    tabs: [
      { tabId: "main", title: "Overview", position: 0, chatDock: "right" },
      { tabId: "research", title: "Research", position: 1, chatDock: "bottom" },
    ],
    widgets: (
      [
        ["session-status", "Session status", "main", "html", 4, 3, 0, "granted"],
        ["recent-findings", "Recent findings", "main", "mcp-app", 8, 6, 1, "pending"],
        ["source-map", "Source map", "research", "html", 12, 8, 0, "none"],
      ] as const
    ).map(([name, title, tabId, contentKind, sizeW, sizeH, position, grantState]) => ({
      name,
      title,
      tabId,
      contentKind,
      sizeW,
      sizeH,
      position,
      grantState,
      revision: 1,
    })),
  };
}

export function createMockBoardProvider(rawSessionKey: string): BoardProvider & {
  emitCommand(command: BoardCommand): void;
} {
  const sessionKey = normalizeDefaultMainSessionAliasForUi(rawSessionKey);
  const snapshot$ = new ValueSignal(mockSnapshot(sessionKey));
  const events = new EventStream<BoardCommandEvent>();
  const publish = (snapshot: BoardSnapshot) =>
    snapshot$.set({ ...snapshot, revision: snapshot.revision + 1 });
  function pinMockBoardWidget(
    input: BoardPinWidgetInput | BoardPinMcpAppInput,
    name: string,
    contentKind: "html" | "mcp-app",
  ): void {
    const snapshot = snapshot$.value;
    const title = normalizeBoardWidgetTitle(input.title);
    const tabId = input.tabId ?? snapshot.tabs[0]?.tabId ?? "main";
    const tabs = snapshot.tabs.length
      ? snapshot.tabs
      : [
          {
            tabId: "main",
            title: t("chat.board.defaultTab"),
            position: 0,
            chatDock: "right" as const,
          },
        ];
    const existing = snapshot.widgets.find((widget) => widget.name === name);
    const widgets = snapshot.widgets.filter((widget) => widget.name !== name);
    widgets.push({
      name,
      tabId,
      ...(title ? { title } : {}),
      contentKind,
      sizeW: existing?.sizeW ?? 6,
      sizeH: existing?.sizeH ?? 4,
      position: existing?.position ?? widgets.filter((widget) => widget.tabId === tabId).length,
      grantState: "none",
      revision: (existing?.revision ?? 0) + 1,
      ...(contentKind === "html"
        ? { frameUrl: `about:blank#board-widget=${encodeURIComponent(name)}` }
        : {}),
    });
    publish(normalizeMockBoardSnapshot({ ...snapshot, tabs, widgets }));
  }

  return {
    sessionKey,
    appViewGeneration: 0,
    canMutate: true,
    canGrant: true,
    canPinWidgets: true,
    canPinMcpApps: true,
    hasLoadedSnapshot: true,
    loadError$: new ValueSignal<string | null>(null),
    snapshot$,
    events,
    async applyOps(ops) {
      let snapshot = snapshot$.value;
      for (const op of ops) {
        snapshot = normalizeMockBoardSnapshot(applyMockBoardOp(snapshot, op));
      }
      publish(snapshot);
    },
    async grant(name, decision) {
      const snapshot = snapshot$.value;
      const index = snapshot.widgets.findIndex((widget) => widget.name === name);
      publish({
        ...snapshot,
        widgets: snapshot.widgets.map((widget, i) =>
          i === index ? Object.assign({}, widget, { grantState: decision }) : widget,
        ),
      });
    },
    async pinWidget(input) {
      pinMockBoardWidget(input, input.name ?? canvasWidgetNameForDocument(input.docId), "html");
    },
    async pinMcpApp(input) {
      pinMockBoardWidget(input, input.name ?? mcpAppWidgetNameForViewId(input.viewId), "mcp-app");
    },
    widgetFrameUrl(name, revision) {
      return (
        snapshot$.value.widgets.find(
          (widget) => widget.name === name && widget.revision === revision,
        )?.frameUrl ?? `about:blank#board-widget=${encodeURIComponent(name)}&revision=${revision}`
      );
    },
    async refreshWidgetFrame(_name) {},
    async widgetAppView(_name, _revision): Promise<BoardWidgetAppViewState> {
      return { status: "stale" };
    },
    async refreshWidgetAppView(name, revision) {
      return await this.widgetAppView(name, revision);
    },
    emitCommand(command) {
      events.emit({ sessionKey, command });
    },
  };
}
