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

const HEBREW_DOCUMENT = [
  "## כותרת המסמך",
  "",
  "> ציטוט בעברית",
  "",
  "- פריט ראשון",
  "- פריט שני",
  "- [ ] משימה פתוחה",
].join("\n");

const ENGLISH_DOCUMENT = [
  "## Document heading",
  "",
  "> An English quote",
  "",
  "- First item",
  "- [ ] An open task",
].join("\n");

describe.runIf(browserMode)("chat sidebar markdown direction", () => {
  it.each([
    { dir: "rtl", content: HEBREW_DOCUMENT, start: "Right", end: "Left" },
    { dir: "ltr", content: ENGLISH_DOCUMENT, start: "Left", end: "Right" },
  ] as const)(
    "lays out the quote, list and checkbox for $dir",
    async ({ dir, content, start, end }) => {
      const panel = await mountDetailPanel({ kind: "markdown", content });
      const reader = panel.querySelector<HTMLElement>(".sidebar-markdown-reader")!;
      expect(reader.getAttribute("dir")).toBe(dir);
      const style = (selector: string) => getComputedStyle(reader.querySelector(selector)!);
      const quote = style("blockquote");
      expect(quote[`border${start}Width`]).toBe("3px");
      expect(quote[`border${end}Width`]).toBe("0px");
      const list = style("ul");
      expect(Number.parseFloat(list[`padding${start}`])).toBeGreaterThan(0);
      expect(Number.parseFloat(list[`padding${end}`])).toBe(0);
      // Only inline-end is overridden; the opposite margin retains the UA default.
      const checkbox = style(".task-list-item-checkbox");
      expect(Number.parseFloat(checkbox[`margin${end}`])).toBeCloseTo(
        Number.parseFloat(checkbox.fontSize) * 0.4,
        0,
      );
    },
  );

  it("gives each line of a code block its own direction", async () => {
    const panel = await mountDetailPanel({
      kind: "markdown",
      content: ["```", "שורה בעברית", "an english line", "```"].join("\n"),
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
