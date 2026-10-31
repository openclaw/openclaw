import { board } from "./chat-layout-fixtures.test-support.ts";

export const sessionKey = "agent:main:dashboard";
const emptyBoard = board(sessionKey);
export function dashboardWidget<T extends object>(name: string, title: string, overrides: T) {
  return {
    name,
    tabId: "main",
    title,
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "pending",
    revision: 1,
    ...overrides,
  };
}

export const boardSnapshot = {
  ...emptyBoard,
  tabs: [
    ...emptyBoard.tabs,
    { tabId: "research", title: "Research", position: 1, chatDock: "right" },
  ],
  widgets: [
    dashboardWidget("status", "Status", { frameUrl: "about:blank#status" }),
    dashboardWidget("sources", "Sources", { tabId: "research", frameUrl: "about:blank#sources" }),
  ],
};
export const pluginWidgetBoardSnapshot = {
  ...emptyBoard,
  widgets: [
    dashboardWidget("workboard-card", "Priority card", {
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-widget-ready" },
      grantState: "none",
    }),
    dashboardWidget("workboard-summary", "Platform summary", {
      contentKind: "plugin",
      pluginKind: "workboard:mini",
      props: { boardId: "platform", limit: 2 },
      position: 1,
      grantState: "none",
    }),
  ],
};
