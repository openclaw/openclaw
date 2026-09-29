import { html, render } from "lit";
import { describe, expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { SidebarContent } from "./chat-sidebar.ts";
import "./chat-files-panel.ts";
import "./chat-sidebar.ts";

const browserMode = "__vitest_browser__" in globalThis;

type DetailPanel = HTMLElement & {
  content: SidebarContent;
  updateComplete: Promise<unknown>;
};

async function mountDetailPanel(
  host: "Review" | "Files",
  content: SidebarContent,
): Promise<{
  panel: DetailPanel;
  hideAndReselect: () => Promise<void>;
  release: () => void;
}> {
  const container = document.createElement("div");
  container.className = "side-panel__panel";
  container.style.cssText = "width:480px;height:320px;";
  const renderDetail = (detail: SidebarContent) => html`<openclaw-chat-detail-panel
    class="chat-sidebar"
    .content=${detail}
    .embedded=${true}
  ></openclaw-chat-detail-panel>`;
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
    render(renderDetail(content), container);
  }
  document.body.append(container);
  await files?.updateComplete;
  const panel = container.querySelector<DetailPanel>("openclaw-chat-detail-panel")!;
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
    release: () => container.remove(),
  };
}

describe.runIf(browserMode)("chat sidebar layout", () => {
  it.each(["Review", "Files"] as const)("keeps long markdown scrollable in %s", async (host) => {
    const { panel, hideAndReselect, release } = await mountDetailPanel(host, {
      kind: "markdown",
      content: Array.from(
        { length: 40 },
        (_, index) => `## Section ${index + 1}\n\nLong preview content for scrolling.`,
      ).join("\n\n"),
    });

    try {
      const content = panel.querySelector<HTMLElement>(".sidebar-content");
      expect(content).not.toBeNull();
      expect(content!.clientHeight).toBeGreaterThan(0);
      expect(content!.clientHeight).toBeLessThan(content!.scrollHeight);

      content!.scrollTop = content!.scrollHeight;
      await new Promise(requestAnimationFrame);
      expect(content!.scrollTop).toBeGreaterThan(0);
      const lastParagraph = panel.querySelector<HTMLElement>(".sidebar-markdown > p:last-child")!;
      expect(lastParagraph.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        content!.getBoundingClientRect().bottom,
      );

      content!.scrollTop = 180;
      const readingTop = content!.scrollTop;
      await hideAndReselect();
      expect(content!.scrollTop).toBe(readingTop);
    } finally {
      release();
    }
  });

  it.each(["Review", "Files"] as const)("keeps long files scrollable in %s", async (host) => {
    const { panel, hideAndReselect, release } = await mountDetailPanel(host, {
      kind: "file",
      path: "src/long-example.ts",
      name: "long-example.ts",
      language: "typescript",
      content: Array.from(
        { length: 200 },
        (_, index) => `export const value${index + 1} = ${index + 1};`,
      ).join("\n"),
    });

    try {
      await expect
        .poll(() => panel.querySelector<HTMLElement>(".cm-scroller"), { timeout: 5_000 })
        .not.toBeNull();
      const scroller = panel.querySelector<HTMLElement>(".cm-scroller");
      expect(scroller).not.toBeNull();
      expect(scroller!.clientHeight).toBeGreaterThan(0);
      expect(scroller!.clientHeight).toBeLessThan(scroller!.scrollHeight);

      scroller!.scrollTop = scroller!.scrollHeight;
      await expect
        .poll(() => panel.querySelector(".cm-line:last-child")?.textContent)
        .toBe("export const value200 = 200;");
      expect(scroller!.scrollTop).toBeGreaterThan(0);
      const lastLine = panel.querySelector<HTMLElement>(".cm-line:last-child")!;
      expect(lastLine.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        scroller!.getBoundingClientRect().bottom,
      );

      scroller!.scrollTop = 180;
      await new Promise(requestAnimationFrame);
      const readingTop = scroller!.scrollTop;
      await hideAndReselect();
      expect(scroller!.scrollTop).toBe(readingTop);
    } finally {
      release();
    }
  });
});
