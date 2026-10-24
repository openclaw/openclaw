import { describe, expect, it, onTestFinished } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
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
  const files = host === "Files" ? document.createElement("openclaw-chat-files-panel") : null;
  if (files) {
    files.previews = [{ id: "preview", label: "Long preview", content }];
    files.activeId = "preview";
    files.renderDetail = () => detailPanel;
    files.onSelect = (id) => {
      files.activeId = id;
    };
    container.append(files);
  } else {
    container.append(detailPanel);
  }
  document.body.append(container);
  onTestFinished(() => container.remove());
  await files?.updateComplete;
  const panel = container.querySelector("openclaw-chat-detail-panel")!;
  await panel.updateComplete;

  return {
    panel,
    hideAndReselect: async () => {
      for (const visible of [false, true]) {
        if (files) {
          files.selectHostedTab(visible ? "preview" : "browse");
          await files.updateComplete;
          if (visible) {
            await panel.updateComplete;
          }
        } else {
          container.hidden = !visible;
        }
        await new Promise(requestAnimationFrame);
        expect(panel.checkVisibility()).toBe(visible);
      }
    },
  };
}

describe.runIf(browserMode).each(["Review", "Files"] as const)(
  "chat sidebar layout in %s",
  (host) => {
    it.each(["markdown", "file"] as const)("keeps long %s scrollable", async (kind) => {
      const content: ChatDetailPanelContent =
        kind === "markdown"
          ? {
              kind,
              content: "## Section\n\nLong preview content for scrolling.\n\n".repeat(40).trimEnd(),
            }
          : {
              kind,
              path: "src/long-example.ts",
              name: "long-example.ts",
              language: "typescript",
              content: Array.from(
                { length: 200 },
                (_, i) => `export const value${i + 1} = ${i + 1};`,
              ).join("\n"),
            };
      const { panel, hideAndReselect } = await mountDetailPanel(host, content);
      const query = (selector: string) => panel.querySelector<HTMLElement>(selector)!;
      if (kind === "file") {
        await expect.poll(() => query(".cm-scroller"), { timeout: 5_000 }).not.toBeNull();
      }
      const scroller = query(kind === "file" ? ".cm-scroller" : ".sidebar-content");
      const lastLine = () =>
        query(kind === "file" ? ".cm-line:last-child" : ".sidebar-markdown > p:last-child");
      expect(scroller).not.toBeNull();
      expect(scroller.clientHeight).toBeGreaterThan(0);
      expect(scroller.clientHeight).toBeLessThan(scroller.scrollHeight);
      scroller.scrollTop = scroller.scrollHeight;
      if (kind === "file") {
        await expect.poll(() => lastLine()?.textContent).toBe("export const value200 = 200;");
      } else {
        await new Promise(requestAnimationFrame);
      }
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(lastLine().getBoundingClientRect().bottom).toBeLessThanOrEqual(
        scroller.getBoundingClientRect().bottom,
      );
      scroller.scrollTop = 180;
      if (kind === "file") {
        await new Promise(requestAnimationFrame);
      }
      const readingTop = scroller.scrollTop;
      await hideAndReselect();
      expect(scroller.scrollTop).toBe(readingTop);
    });
  },
);
