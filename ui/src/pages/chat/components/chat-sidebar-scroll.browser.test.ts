import { describe, expect, it, onTestFinished } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { ChatDetailPanel } from "./chat-detail-panel.tsx";
import type { ChatDetailPanelContent } from "./chat-sidebar-content-types.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "./chat-files-panel.tsx";
import "./chat-detail-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;

async function mountDetailPanel(host: "Review" | "Files", content: ChatDetailPanelContent) {
  const container = createChatSidebarContainer();
  container.className = "side-panel__panel";
  container.style.cssText = "width:480px;height:320px;";
  const detailPanel = document.createElement("openclaw-chat-detail-panel");
  detailPanel.className = "chat-sidebar";
  detailPanel.embedded = true;
  detailPanel.content = content;
  const renderDetail = () => detailPanel;
  const files = host === "Files" ? document.createElement("openclaw-chat-files-panel") : null;
  if (files) {
    files.previews = [{ id: "preview", label: "Long preview", content }];
    files.activeId = "preview";
    files.renderDetail = renderDetail;
    files.onSelect = (id) => {
      files.activeId = id;
    };
    container.append(files);
  } else {
    container.append(renderDetail());
  }
  document.body.append(container);
  onTestFinished(() => container.remove());
  await files?.updateComplete;
  const panel = container.querySelector<ChatDetailPanel>("openclaw-chat-detail-panel")!;
  await panel.updateComplete;

  return {
    panel,
    hideAndReselect: async () => {
      if (files) {
        files.selectHostedTab("browse");
        await files.updateComplete;
      } else {
        container.hidden = true;
      }
      await new Promise(requestAnimationFrame);
      expect(panel.checkVisibility()).toBe(false);
      if (files) {
        files.selectHostedTab("preview");
        await files.updateComplete;
        await panel.updateComplete;
      } else {
        container.hidden = false;
      }
      await new Promise(requestAnimationFrame);
      expect(panel.checkVisibility()).toBe(true);
    },
  };
}

async function checkScrolling(
  scroller: HTMLElement,
  lastLine: () => HTMLElement,
  hideAndReselect: () => Promise<void>,
  settleEnd: () => Promise<unknown> = () => new Promise(requestAnimationFrame),
  settlePosition = false,
) {
  expect(scroller).not.toBeNull();
  expect(scroller.clientHeight).toBeGreaterThan(0);
  expect(scroller.clientHeight).toBeLessThan(scroller.scrollHeight);
  scroller.scrollTop = scroller.scrollHeight;
  await settleEnd();
  expect(scroller.scrollTop).toBeGreaterThan(0);
  expect(lastLine().getBoundingClientRect().bottom).toBeLessThanOrEqual(
    scroller.getBoundingClientRect().bottom,
  );
  scroller.scrollTop = 180;
  if (settlePosition) {
    await new Promise(requestAnimationFrame);
  }
  const readingTop = scroller.scrollTop;
  await hideAndReselect();
  expect(scroller.scrollTop).toBe(readingTop);
}

describe.runIf(browserMode)("chat sidebar layout", () => {
  it.each(["Review", "Files"] as const)("keeps long markdown scrollable in %s", async (host) => {
    const { panel, hideAndReselect } = await mountDetailPanel(host, {
      kind: "markdown",
      content: Array.from(
        { length: 40 },
        (_, index) => `## Section ${index + 1}\n\nLong preview content for scrolling.`,
      ).join("\n\n"),
    });

    await checkScrolling(
      panel.querySelector<HTMLElement>(".sidebar-content")!,
      () => panel.querySelector<HTMLElement>(".sidebar-markdown > p:last-child")!,
      hideAndReselect,
    );
  });

  it.each(["Review", "Files"] as const)("keeps long files scrollable in %s", async (host) => {
    const { panel, hideAndReselect } = await mountDetailPanel(host, {
      kind: "file",
      path: "src/long-example.ts",
      name: "long-example.ts",
      language: "typescript",
      content: Array.from(
        { length: 200 },
        (_, index) => `export const value${index + 1} = ${index + 1};`,
      ).join("\n"),
    });

    await expect.poll(() => panel.querySelector(".cm-scroller"), { timeout: 5_000 }).not.toBeNull();
    const lastLine = () => panel.querySelector<HTMLElement>(".cm-line:last-child")!;
    await checkScrolling(
      panel.querySelector<HTMLElement>(".cm-scroller")!,
      lastLine,
      hideAndReselect,
      () => expect.poll(() => lastLine()?.textContent).toBe("export const value200 = 200;"),
      true,
    );
  });
});
