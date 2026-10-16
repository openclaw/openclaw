import { createComponent } from "solid-js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { SessionDiffPanel } from "./session-diff-panel.ts";

const browserMode = "__vitest_browser__" in globalThis;
const branch = "openclaw/investigating-why-a-pr-was-not-merged";
const root = "/workspace/investigating-why-a-pr-was-not-merged";

afterEach(() => document.body.replaceChildren());

describe.runIf(browserMode)("Review header layout", () => {
  it("uses available width before truncating and preserves keyboard access to sync actions", async () => {
    const { page, userEvent } = await import("vitest/browser");
    await page.viewport(1200, 800);
    let panel!: HTMLElementTagNameMap["openclaw-session-diff"];
    mountSolid(() =>
      createComponent(SessionDiffPanel, {
        ref: (element) => {
          panel = element;
        },
      }),
    );
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
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__branch-label")?.textContent).toBe(
        `main → ${branch}`,
      ),
    );
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

    const sync = panel.querySelector<HTMLButtonElement>(".session-diff__toolbar-button")!;
    const view = panel.querySelector<HTMLButtonElement>(".session-diff__toolbar-icon")!;
    await userEvent.click(sync);
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff-menu__surface")?.matches(":popover-open")).toBe(
        true,
      ),
    );
    const command = panel.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy sync command"]',
    );
    const checkout = panel.querySelector<HTMLButtonElement>('button[aria-label="Checkout path"]');
    const branchCopy = panel.querySelector<HTMLButtonElement>('button[aria-label="Branch name"]');
    expect(command).toBeInstanceOf(HTMLButtonElement);
    expect(checkout).toBeInstanceOf(HTMLButtonElement);
    expect(branchCopy).toBeInstanceOf(HTMLButtonElement);
    await waitForSolid(() => expect(document.activeElement).toBe(command));
    await userEvent.tab();
    expect(document.activeElement).toBe(checkout);
    await userEvent.tab();
    expect(document.activeElement).toBe(branchCopy);

    let returnedToSync = false;
    sync.addEventListener(
      "focus",
      () => {
        returnedToSync = true;
      },
      { once: true },
    );
    await userEvent.tab();
    await waitForSolid(() => expect(panel.querySelector("openclaw-session-diff-menu")).toBeNull());
    expect(returnedToSync).toBe(true);
    // Native Tab continues past the restored Sync trigger.
    expect(document.activeElement).toBe(view);

    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    onTestFinished(() => writeText.mockRestore());
    const fileMenu = panel.querySelector<HTMLButtonElement>(".session-diff__file-menu")!;
    fileMenu.focus();
    await userEvent.keyboard("{Enter}");
    const fileSurface = panel.querySelector<HTMLElement>(".session-diff-menu__surface")!;
    await waitForSolid(() => expect(fileSurface.matches(":popover-open")).toBe(true));
    const copyPath = fileSurface.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy Path"]',
    )!;
    await waitForSolid(() => expect(document.activeElement).toBe(copyPath));
    for (const key of ["{Enter}", " "]) {
      const calls = writeText.mock.calls.length;
      await userEvent.keyboard(key);
      await waitForSolid(() => {
        expect(writeText).toHaveBeenCalledTimes(calls + 1);
        expect(writeText).toHaveBeenLastCalledWith("added.ts");
        expect(copyPath.disabled).toBe(false);
      });
      expect(fileSurface.matches(":popover-open")).toBe(true);
      expect(document.activeElement).toBe(copyPath);
    }
  });
});
