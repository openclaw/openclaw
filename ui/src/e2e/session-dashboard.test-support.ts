import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { board } from "./chat-layout-fixtures.test-support.ts";

export const sessionKey = "agent:main:dashboard";
const emptyBoard = board(sessionKey);
export const emptyCronList = (snapshotRevision: string) => ({
  jobs: [],
  snapshotRevision,
  offset: 0,
  limit: 50,
  total: 0,
  hasMore: false,
  nextOffset: null,
});
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
function withPinnedWidget<T extends object>(widget: T) {
  return { ...boardSnapshot, revision: 2, widgets: [...boardSnapshot.widgets, widget] };
}
export const pinnedBoardSnapshot = withPinnedWidget(
  dashboardWidget("canvas-cv_release", "Release status", {
    position: 1,
    frameUrl: "about:blank#canvas-cv_release",
  }),
);
export const pinnedMcpAppBoardSnapshot = withPinnedWidget(
  dashboardWidget("mcp-app-28b65635ecaa78ac", "Demo App", {
    contentKind: "mcp-app",
    position: 1,
    instanceId: "instance-pinned-app",
  }),
);
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

export async function captureWidgetDetailsPlacement(
  page: Page,
  artifactDir: string,
  content: Locator[],
) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const conversation = page.locator(".chat-main__conversation");
  const frame = await takeControlUiScreenshotFrame(page, conversation, content, {
    animations: "disabled",
    elements: [conversation],
  });
  await writeFile(path.join(artifactDir, "widget-details-placement.png"), frame.png);
  await writeFile(
    path.join(artifactDir, "widget-details-placement-crop.png"),
    frame.elements[0]!.png,
  );
}
