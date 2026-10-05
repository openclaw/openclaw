import { afterEach, describe, expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { settleLitElement } from "../../../test-helpers/lit-settle.ts";
import "./session-diff-panel.ts";

const browserMode = "__vitest_browser__" in globalThis;
const branch = "openclaw/investigating-why-a-pr-was-not-merged";
const root = "/workspace/investigating-why-a-pr-was-not-merged";

afterEach(() => document.body.replaceChildren());

describe.runIf(browserMode)("Review header layout", () => {
  it("uses available width before truncating and preserves actions when narrowed", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(1200, 800);
    const panel = document.createElement("openclaw-session-diff");
    panel.style.cssText = "display:block;width:1100px;padding:8px";
    panel.loader = async () => ({
      sessionKey: "main",
      root,
      branch,
      baseRef: "main",
      additions: 700,
      deletions: 120,
      files: [
        { path: "added.ts", status: "added", additions: 600, deletions: 0 },
        { path: "removed.ts", status: "deleted", additions: 0, deletions: 20 },
        { path: "changed.ts", status: "modified", additions: 100, deletions: 100 },
      ],
    });
    document.body.append(panel);
    await settleLitElement(panel);
    const summary = panel.querySelector<HTMLElement>(".session-diff__summary")!;
    const label = panel.querySelector<HTMLElement>(".session-diff__branch-label")!;
    expect(label.clientWidth).toBe(label.scrollWidth);
    const wideWidth = label.clientWidth;
    expect(panel.querySelector(".session-diff__branch")?.getAttribute("title")).toBe(
      `main → ${branch}\n${root}`,
    );

    const controls = [...summary.querySelectorAll(".chat-diffstat, button")];
    const widths = controls.map((control) => control.getBoundingClientRect().width);
    for (const width of [360, 540, 1100]) {
      panel.style.width = `${width}px`;
      const bounds = summary.getBoundingClientRect();
      expect(summary.scrollWidth).toBe(summary.clientWidth);
      if (width < 1100) {
        expect(label.clientWidth).toBeLessThan(label.scrollWidth);
        expect(label.clientWidth).toBeLessThan(wideWidth);
      } else {
        expect(label.clientWidth).toBe(label.scrollWidth);
      }
      controls.forEach((control, index) => {
        const rect = control.getBoundingClientRect();
        expect(rect.width).toBeCloseTo(widths[index]!, 1);
        expect(rect.right).toBeLessThanOrEqual(bounds.right);
        expect(rect.left).toBeGreaterThanOrEqual(label.getBoundingClientRect().right);
      });
    }
  });
});
