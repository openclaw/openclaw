import { expect, it, onTestFinished } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/side-panel.css";
import type { ChatDetailPanelContent } from "./chat-sidebar-content-types.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "./chat-files-panel.tsx";
import "./chat-detail-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;

it.runIf(browserMode).each([
  ["Review", "markdown"],
  ["Review", "file"],
  ["Files", "markdown"],
  ["Files", "file"],
] as const)("keeps long %s/%s content scrollable", async (host, kind) => {
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
          content: "export const value = 1;\n".repeat(199) + "export const value200 = 200;",
        };
  const container = createChatSidebarContainer();
  container.className = "side-panel__panel";
  container.style.cssText = "width:480px;height:320px;";
  const panel = document.createElement("openclaw-chat-detail-panel");
  panel.className = "chat-sidebar";
  panel.embedded = true;
  panel.content = content;
  const files = host === "Files" ? document.createElement("openclaw-chat-files-panel") : null;
  if (files) {
    files.previews = [{ id: "preview", label: "Long preview", content }];
    files.activeId = "preview";
    files.renderDetail = () => panel;
    files.onSelect = (id) => {
      files.activeId = id;
    };
  }
  container.append(files ?? panel);
  document.body.append(container);
  onTestFinished(() => container.remove());
  await files?.updateComplete;
  await panel.updateComplete;
  const query = (selector: string) => panel.querySelector<HTMLElement>(selector)!;
  if (kind === "file") {
    await expect.poll(() => query(".cm-scroller"), { timeout: 5_000 }).not.toBeNull();
  }
  const scroller = query(kind === "file" ? ".cm-scroller" : ".sidebar-content");
  const lastLine = () =>
    query(kind === "file" ? ".cm-line:last-child" : ".sidebar-markdown > p:last-child");
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
  expect(scroller.scrollTop).toBe(readingTop);
});
