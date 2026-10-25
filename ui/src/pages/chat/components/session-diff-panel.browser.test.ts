import { createComponent } from "solid-js";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { SessionDiffProps } from "./chat-sidebar-content-types.ts";
import { SessionDiffPanel } from "./session-diff-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;
const branch = "openclaw/investigating-why-a-pr-was-not-merged";
const root = "/workspace/investigating-why-a-pr-was-not-merged";
const addedFile = { path: "added.ts", status: "added", additions: 1, deletions: 0 } as const;
const result = (overrides: Partial<SessionsDiffResult> = {}): SessionsDiffResult => ({
  sessionKey: "main",
  root,
  branch,
  baseRef: "main",
  additions: 1,
  deletions: 0,
  files: [addedFile],
  ...overrides,
});

async function mountBrowserPanel(props: Partial<SessionDiffProps> = {}, width = 1200) {
  const browser = await import("vitest/browser");
  await browser.page.viewport(width, 800);
  const mounted = mountSolid(() =>
    createComponent(SessionDiffPanel, {
      mobile: false,
      owner: null,
      execNode: null,
      loadFileText: null,
      openFile: null,
      revealFile: null,
      loader: async () => result(),
      ...props,
    }),
  );
  const panel = mounted.container.querySelector<HTMLElement>("openclaw-session-diff")!;
  const button = (selector: string) => panel.querySelector<HTMLButtonElement>(selector)!;
  const surface = () => panel.querySelector<HTMLElement>(".session-diff-menu__surface")!;
  const menuOpen = () => waitForSolid(() => expect(surface()?.matches(":popover-open")).toBe(true));
  const menuClosed = () =>
    waitForSolid(() => expect(panel.querySelector("openclaw-session-diff-menu")).toBeNull());
  return { panel, button, surface, menuOpen, menuClosed, userEvent: browser.userEvent };
}

afterEach(() => document.body.replaceChildren());

describe.runIf(browserMode)("Review header layout", () => {
  it("settles Review navigation before focusing and scrolling its destination", async () => {
    const paths = ["first.txt", "selected.txt", "last.txt"];
    const { panel, button, userEvent } = await mountBrowserPanel({
      loader: async () => ({
        sessionKey: "main",
        additions: 90,
        deletions: 0,
        files: paths.map((path) => ({
          path,
          status: "added",
          additions: 30,
          deletions: 0,
          patch: `@@ -0,0 +1,30 @@\n${Array.from({ length: 30 }, (_, index) => `+line ${index + 1}`).join("\n")}`,
        })),
      }),
    });
    panel.style.cssText = "display:flex;position:fixed;left:0;top:0;width:1100px;height:500px";
    await waitForSolid(() => expect(panel.querySelectorAll(".session-diff__file")).toHaveLength(3));
    const files = [...panel.querySelectorAll<HTMLElement>(".session-diff__file")];
    const selected = files[1]!;
    const toggle = selected.querySelector<HTMLButtonElement>(".session-diff__file-toggle")!;
    const viewport = selected.parentElement!;
    const searchTrigger = button('button[aria-label="Search changed files"]');
    searchTrigger.focus();
    await userEvent.keyboard("{Enter}");
    const search = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Search changed files"]',
    )!;
    expect(document.activeElement).toBe(search);
    await userEvent.fill(search, "selected");
    expect(panel.querySelectorAll(".session-diff__tree-row")).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    expect(panel.querySelector('input[aria-label="Search changed files"]')).toBeNull();
    expect(document.activeElement).toBe(searchTrigger);
    expect(panel.querySelectorAll(".session-diff__tree-row")).toHaveLength(3);
    await userEvent.keyboard("{Enter}");
    const reopenedSearch = panel.querySelector<HTMLInputElement>(
      'input[aria-label="Search changed files"]',
    )!;
    expect(document.activeElement).toBe(reopenedSearch);
    expect(reopenedSearch.value).toBe("");

    // Keep content below the selected file so viewport clamping cannot mask its scroll target.
    const lastToggle = files[2]!.querySelector<HTMLButtonElement>(".session-diff__file-toggle")!;
    lastToggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(lastToggle.getAttribute("aria-expanded")).toBe("true");

    const jump = button(".session-diff__jump");
    jump.focus();
    await userEvent.keyboard("{Enter}");
    const destination = button('button[data-value="jump:1"]');
    await userEvent.click(destination);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const body = selected.querySelector<HTMLElement>(".session-diff__file-body")!;
    expect(body.checkVisibility()).toBe(true);
    expect(selected.getBoundingClientRect().top).toBeCloseTo(
      viewport.getBoundingClientRect().top,
      0,
    );

    viewport.scrollTop += 120;
    expect(selected.getBoundingClientRect().top).toBeLessThan(viewport.getBoundingClientRect().top);
    // The sticky header remains reachable while reading farther down this file.
    await userEvent.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(selected.querySelector(".session-diff__file-body")).toBeNull();
    expect(selected.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      viewport.getBoundingClientRect().top,
    );
    expect(document.activeElement).toBe(toggle);
    expect([...panel.querySelectorAll(".session-diff__file")]).toEqual(files);
  });

  it("uses available width before truncating and preserves keyboard access to sync actions", async () => {
    const { panel, button, surface, menuOpen, menuClosed, userEvent } = await mountBrowserPanel({
      loader: async () =>
        result({
          additions: 700,
          deletions: 120,
          files: [
            { path: "added.ts", status: "added", additions: 600, deletions: 0 },
            { path: "removed.ts", status: "deleted", additions: 0, deletions: 20 },
            { path: "changed.ts", status: "modified", additions: 100, deletions: 100 },
          ],
        }),
    });
    panel.style.cssText = "display:block;width:1100px;padding:8px";
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__branch-label")?.textContent).toBe(
        `main → ${branch}`,
      ),
    );
    const summary = panel.querySelector<HTMLElement>(".session-diff__summary")!;
    const label = panel.querySelector<HTMLElement>(".session-diff__branch-label")!;
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

    const sync = button(".session-diff__toolbar-button");
    const view = button(".session-diff__toolbar-icon");
    await userEvent.click(sync);
    await menuOpen();
    const command = button('button[aria-label="Copy sync command"]');
    const checkout = button('button[aria-label="Checkout path"]');
    const branchCopy = button('button[aria-label="Branch name"]');
    await waitForSolid(() => expect(document.activeElement).toBe(command));
    await userEvent.tab();
    expect(document.activeElement).toBe(checkout);
    await userEvent.tab();
    expect(document.activeElement).toBe(branchCopy);

    const returnedToSync = vi.fn();
    sync.addEventListener("focus", returnedToSync, { once: true });
    await userEvent.tab();
    await menuClosed();
    expect(returnedToSync).toHaveBeenCalledOnce();
    // Native Tab continues past the restored Sync trigger.
    expect(document.activeElement).toBe(view);

    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    onTestFinished(() => writeText.mockRestore());
    const fileMenu = button(".session-diff__file-menu");
    fileMenu.focus();
    await userEvent.keyboard("{Enter}");
    const fileSurface = surface();
    await menuOpen();
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
  it("keeps a disabled path copy mounted through clipboard fallback focus changes", async () => {
    const pending = Promise.withResolvers<void>();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(pending.promise);
    const fallback = vi.spyOn(document, "execCommand").mockReturnValue(true);
    onTestFinished(() => {
      pending.reject(new Error("test finished"));
      write.mockRestore();
      fallback.mockRestore();
    });
    const browser = await mountBrowserPanel();
    const { panel, button, userEvent } = browser;
    panel.style.cssText = "display:block;position:fixed;left:0;top:0;width:1100px;height:600px";
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__file-menu")).not.toBeNull(),
    );
    const trigger = button(".session-diff__file-menu");
    await userEvent.click(trigger);
    const surface = browser.surface();
    await browser.menuOpen();
    const copy = surface.querySelector<HTMLButtonElement>('[data-value="copy-path"]')!;
    await userEvent.click(copy);
    expect(write).toHaveBeenCalledExactlyOnceWith("added.ts");
    expect(copy.disabled).toBe(true);
    pending.reject(new DOMException("Clipboard denied", "NotAllowedError"));
    await waitForSolid(() => expect(copy.getAttribute("aria-label")).toBe("Copied!"));
    expect(fallback).toHaveBeenCalledExactlyOnceWith("copy");
    expect(copy.isConnected).toBe(true);
    expect(surface.matches(":popover-open")).toBe(true);
    await userEvent.keyboard("{Escape}");
    await browser.menuClosed();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps mobile Review menus reachable inside a translated dock and restores the real trigger", async () => {
    const openPage = vi.fn();
    const pending = Promise.withResolvers<SessionsDiffResult>();

    const browser = await mountBrowserPanel(
      {
        mobile: true,
        onOpenMobilePage: openPage,
        loader: () => pending.promise,
      },
      390,
    );
    const { panel, button, userEvent } = browser;
    // The sheet's resting translate establishes a fixed-position containing block.
    panel.style.cssText =
      "display:block;position:fixed;left:0;top:400px;width:390px;height:400px;translate:0 0";
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff-mobile__rail")).not.toBeNull(),
    );
    const view = button(".session-diff-mobile__rail .session-diff__toolbar-icon");
    await userEvent.click(view);
    await browser.menuOpen();
    const surface = browser.surface();
    const bounds = surface.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
    pending.resolve(result());
    await waitForSolid(() => expect(panel.querySelector(".session-diff__file")).not.toBeNull());
    expect(panel.querySelector(".session-diff-mobile__rail .session-diff__toolbar-icon")).toBe(
      view,
    );
    await userEvent.keyboard("{Escape}");
    await browser.menuClosed();
    expect(document.activeElement).toBe(view);
    await userEvent.click(view);
    await browser.menuOpen();
    await userEvent.click(button('[data-value="sync"]'));
    await waitForSolid(() => expect(openPage).toHaveBeenCalledTimes(1));
    expect(panel.querySelector("openclaw-session-diff-menu")).toBeNull();
    expect(view.style.getPropertyValue("anchor-name")).toBe("");
  });
});
