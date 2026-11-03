import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enBoardDocument = {
  board: {
    label: "Session dashboard",
    tabsLabel: "Dashboard tabs",
    moreTabs: "More dashboard tabs",
    gridLabel: "Dashboard widgets",
    emptyTitle: "A clear board, ready for work",
    emptyHint: "Your agent can pin widgets here — try asking for a status card.",
    actionFailed: "The dashboard change could not be saved.",
    actionInProgress: "Another dashboard change is still being saved.",
    announcement: {
      moved: "Moved {title}.",
      resized: "Resized {title}.",
      removed: "Removed {title}.",
      granted: "Widget access allowed.",
      rejected: "Widget access rejected.",
    },
    widget: {
      cellLabel:
        "Dashboard widget: {title}. Use arrow keys to navigate. Hold Alt and press an arrow key to move it.",
      moveHandle: "Move {title}",
      resizeHandle: en.board.widget.resizeHandle,
      menuLabel: en.board.widget.menuLabel,
      moveToTab: en.board.widget.moveToTab,
      noOtherTabs: en.board.widget.noOtherTabs,
      resize: en.board.widget.resize,
      autoHeight: en.board.widget.autoHeight,
      remove: en.board.widget.remove,
      kindMcp: "MCP",
      kindHtml: "HTML",
      kindPlugin: "Plugin",
      kindReport: "Report",
      kindWebsite: "Website",
      kindBrowserDashboard: "Browser dashboard",
      pluginLoading: "Loading plugin widget…",
      disabledPlugin: "Widget from disabled plugin {pluginId}",
    },
  },
} satisfies TranslationMap;

export const registerBoardDocumentEnglish = Object.assign(
  () => {
    const { announcement, widget, ...labels } = enBoardDocument.board;
    Object.assign(en.board, labels);
    Object.assign(en.board.announcement, announcement);
    Object.assign(en.board.widget, widget);
  },
  { catalog: enBoardDocument },
);
