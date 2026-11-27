import { describe, expect, it, onTestFinished } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-detail-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;

type DetailPanel = HTMLElement & {
  content: SidebarContent;
  updateComplete: Promise<unknown>;
};

async function mountDetailPanel(content: SidebarContent) {
  const container = document.createElement("div");
  container.className = "side-panel__panel";
  container.style.cssText = "display:flex;width:480px;height:320px;";

  const panel = document.createElement("openclaw-chat-detail-panel") as DetailPanel;
  panel.className = "chat-sidebar";
  panel.content = content;
  container.append(panel);
  document.body.append(container);

  onTestFinished(() => container.remove());
  await panel.updateComplete;
  return panel;
}

describe.runIf(browserMode)("chat sidebar markdown direction", () => {
  it.each([
    {
      dir: "rtl",
      content: "> ציטוט בעברית\n\n- פריט ראשון\n- [ ] משימה פתוחה",
      start: "Right",
      end: "Left",
    },
    {
      dir: "ltr",
      content: "> An English quote\n\n- First item\n- [ ] An open task",
      start: "Left",
      end: "Right",
    },
  ] as const)(
    "lays out the quote, list and checkbox for $dir",
    async ({ dir, content, start, end }) => {
      const panel = await mountDetailPanel({ kind: "markdown", content });
      const reader = panel.querySelector<HTMLElement>(".sidebar-markdown-reader")!;
      expect(reader.getAttribute("dir")).toBe(dir);
      const style = (selector: string) => getComputedStyle(reader.querySelector(selector)!);
      const quote = style("blockquote");
      expect(quote).toMatchObject({ [`border${start}Width`]: "3px", [`border${end}Width`]: "0px" });
      const list = style("ul");
      expect(
        Number.parseFloat(list[start === "Right" ? "paddingRight" : "paddingLeft"]),
      ).toBeGreaterThan(0);
      expect(Number.parseFloat(list[end === "Right" ? "paddingRight" : "paddingLeft"])).toBe(0);
      // Only inline-end is overridden; the opposite margin retains the UA default.
      const checkbox = style(".task-list-item-checkbox");
      expect(
        Number.parseFloat(checkbox[end === "Right" ? "marginRight" : "marginLeft"]),
      ).toBeCloseTo(Number.parseFloat(checkbox.fontSize) * 0.4, 0);
    },
  );

  it("gives each line of a code block its own direction", async () => {
    const panel = await mountDetailPanel({
      kind: "markdown",
      content: "```\nשורה בעברית\nan english line\n```",
    });

    const pre = panel.querySelector<HTMLElement>(".sidebar-markdown-reader pre");
    expect(pre).not.toBeNull();
    expect(getComputedStyle(pre!).unicodeBidi).toBe("plaintext");
  });

  // Shared previews must not inherit the reader-only bidi rule.
  it("leaves code blocks alone on shared markdown surfaces without the reader", () => {
    const surface = document.createElement("div");
    surface.className = "sidebar-markdown";
    const pre = document.createElement("pre");
    pre.textContent = "שורה בעברית\nan english line";
    surface.append(pre);
    document.body.append(surface);

    onTestFinished(() => surface.remove());
    expect(getComputedStyle(pre).unicodeBidi).not.toBe("plaintext");
  });
});
