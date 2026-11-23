import { expect, it, onTestFinished, vi } from "vitest";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  successfulSessionPatch,
} from "../test-helpers/app-sidebar.ts";
import { closeArchiveUndoToast } from "../test-helpers/archive-undo-window.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { emulateOverlayMedia } from "../test-helpers/overlay-browser-media.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "../test-helpers/load-styles.ts";
import { startSidebarArchiveExit } from "./app-sidebar-archive-exit.ts";
import { undoHeldArchive } from "./session-archive-hold.ts";

setupSidebarTest();

it.each([
  { reducedMotion: false, delayedLayout: false, earlyUndo: false, scrolled: true },
  { reducedMotion: false, delayedLayout: false, earlyUndo: false, scrolled: false },
  { reducedMotion: false, delayedLayout: true, earlyUndo: false, scrolled: false },
  { reducedMotion: true, delayedLayout: false, earlyUndo: false, scrolled: false },
  { reducedMotion: false, delayedLayout: false, earlyUndo: true, scrolled: false },
])(
  "hides an archived row with a presentation-only exit (reduced motion: $reducedMotion, delayed layout: $delayedLayout, early undo: $earlyUndo, scrolled: $scrolled)",
  async ({ reducedMotion, delayedLayout, earlyUndo, scrolled }) => {
    await emulateOverlayMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    onTestFinished(() => emulateOverlayMedia({ reducedMotion: "no-preference" }));
    const sessions = createSessionsHarness(
      "main",
      scrolled
        ? Array.from({ length: 48 }, (_, index) => "agent:main:window-" + index)
        : ["agent:main:b", "agent:main:a"],
    );
    let finishPatch!: (value: ReturnType<typeof successfulSessionPatch>) => void;
    sessions.patch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPatch = resolve;
        }),
    );
    const gateway = createGatewayHarness(
      createTestGatewayClient(vi.fn(async () => ({ questions: [] }))),
    );
    gateway.publish({
      hello: gatewayHelloForMethods(["sessions.patch", "sessions.groups.put"], ["operator.admin"]),
    });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.style.cssText = "display:block;width:320px;height:600px";
    sidebar.connected = true;
    await sidebar.updateComplete;
    await waitForSolid(() =>
      expect(sidebar.querySelectorAll("[data-session-key]").length).toBeGreaterThan(1),
    );
    await document.fonts.ready;
    const scroller = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
    if (scrolled) {
      scroller.style.cssText = "height:400px;flex:none;overflow:auto";
      await waitForSolid(() =>
        expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight),
      );
      scroller.scrollTop = 800;
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const { row, next } = await waitForSolid(() => {
      const rows = [...sidebar.querySelectorAll<HTMLElement>("[data-session-key]")];
      if (!scrolled) {
        expect(rows.length).toBeGreaterThan(1);
        return { row: rows[0]!, next: rows[1]! };
      }
      expect(scroller.scrollTop).toBeGreaterThan(0);
      const viewport = scroller.getBoundingClientRect();
      const clippedRow = rows.findLast(
        (candidate) => candidate.getBoundingClientRect().bottom <= viewport.top,
      );
      const visibleAnchor = rows.find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      expect(clippedRow).toBeDefined();
      expect(visibleAnchor).toBeDefined();
      return { row: clippedRow!, next: visibleAnchor! };
    });
    const archivedKey = row.dataset.sessionKey!;
    expect(next.getBoundingClientRect().top).toBeGreaterThan(row.getBoundingClientRect().top);
    const beforeTop = next.getBoundingClientRect().top;
    const beforeRowTop = row.getBoundingClientRect().top;
    const tree = next.closest<HTMLElement>(".sidebar-session-tree")!;
    const archive = row.querySelector<HTMLButtonElement>("[data-sidebar-session-archive]")!;
    expect(archive.disabled, archive.outerHTML).toBe(false);
    const frameCallbacks: FrameRequestCallback[] = [];
    const nativeFrame = window.requestAnimationFrame.bind(window);
    // Native animation can finish while a busy frame queue still holds geometry work.
    const frameGate = delayedLayout
      ? vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
          nativeFrame((time) => {
            if (sidebar.querySelector(`[data-session-key="${archivedKey}"]`)) {
              callback(time);
            } else {
              frameCallbacks.push(callback);
            }
          }),
        )
      : undefined;
    if (scrolled) {
      const pausedExit = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (
        this: HTMLElement,
        keyframes,
        options,
      ) {
        const animation = Element.prototype.animate.call(this, keyframes, options);
        if (this.hasAttribute("data-sidebar-archive-exit")) {
          animation.pause();
        }
        return animation;
      });
      onTestFinished(() => pausedExit.mockRestore());
    }
    archive.click();
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(sessions.sessions.archiveVisibility(archivedKey)).toBe("pending"),
    );
    expect(sessions.patch).not.toHaveBeenCalled();
    await waitForSolid(() =>
      expect(sidebar.querySelector(`[data-session-key="${archivedKey}"]`)).toBeNull(),
    );
    if (scrolled) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    }
    const exit = sidebar.querySelector<HTMLElement>("[data-sidebar-archive-exit]");
    if (reducedMotion || scrolled) {
      expect(exit).toBeNull();
      await waitForSolid(() => {
        if (scrolled) {
          expect(next.getBoundingClientRect().top).toBeCloseTo(beforeTop, 0);
        } else {
          expect(next.getBoundingClientRect().top).toBeLessThan(beforeTop);
        }
      });
    } else {
      expect(exit).not.toBeNull();
      expect(exit!.inert).toBe(true);
      expect(exit!.getAttribute("aria-hidden")).toBe("true");
      expect(exit!.querySelector("[data-session-key]")).toBeNull();
      const [fade] = exit!.getAnimations();
      expect(fade!.effect!.getTiming().duration).toBe(240);
      // Inspect the neighbor's actual position during the exit, rather than
      // assuming a particular CSS property is responsible for its movement.
      fade!.pause();
      fade!.currentTime = 0;
      expect(exit!.getBoundingClientRect().top).toBeCloseTo(beforeRowTop, 0);
      expect(next.getBoundingClientRect().top).toBeCloseTo(beforeTop, 0);
      fade!.currentTime = 190;
      const halfway = next.getBoundingClientRect().top;
      expect(halfway).toBeLessThan(beforeTop);
      if (earlyUndo) {
        undoHeldArchive(archivedKey);
        await waitForSolid(() => {
          expect(sidebar.querySelector(`[data-session-key="${archivedKey}"]`)).not.toBeNull();
          expect(exit!.isConnected).toBe(false);
          expect(next.getBoundingClientRect().top).toBeCloseTo(beforeTop, 0);
        });
        expect(sessions.patch).not.toHaveBeenCalled();
        return;
      }
      fade!.finish();
      await fade!.finished;
      expect(next.getBoundingClientRect().top).toBeLessThan(halfway);
      if (delayedLayout) {
        frameGate!.mockRestore();
        for (const callback of frameCallbacks) {
          nativeFrame(callback);
        }
      }
      expect(
        sidebar
          .querySelector(`[data-session-key="${next.dataset.sessionKey}"]`)
          ?.closest(".sidebar-session-tree"),
      ).toBe(tree);
      for (const animation of sidebar.getAnimations({ subtree: true })) {
        animation.finish();
      }
      await waitForSolid(() =>
        expect(sidebar.querySelector("[data-sidebar-archive-exit]")).toBeNull(),
      );
      expect(next.getBoundingClientRect().top).toBeLessThan(beforeTop);
    }
    await closeArchiveUndoToast();
    await waitForSolid(() => expect(sessions.patch).toHaveBeenCalledOnce());
    finishPatch(successfulSessionPatch(archivedKey));
    await sidebar.updateComplete;
  },
);

it("keeps the exit when a parent is clipped but its child is visible", async () => {
  await emulateOverlayMedia({ reducedMotion: "no-preference" });
  const viewport = document.createElement("div");
  viewport.className = "sidebar-shell__body";
  viewport.style.cssText =
    "position:fixed;top:0;left:0;display:block;width:320px;height:120px;overflow:auto";
  viewport.innerHTML =
    '<div style="height:80px"></div><div class="sidebar-session-tree"><div data-parent style="height:32px">Parent</div><div style="height:80px">Visible child</div></div><div style="height:300px"></div>';
  document.body.append(viewport);
  onTestFinished(() => viewport.remove());
  viewport.scrollTop = 112;
  const tree = viewport.querySelector<HTMLElement>(".sidebar-session-tree")!;
  const parent = tree.querySelector<HTMLElement>("[data-parent]")!;
  expect(parent.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    viewport.getBoundingClientRect().top,
  );
  expect(tree.getBoundingClientRect().bottom).toBeGreaterThan(viewport.getBoundingClientRect().top);
  const exit = startSidebarArchiveExit(parent);
  onTestFinished(() => exit?.cancel());
  expect(exit).toBeDefined();
  tree.remove();
  await Promise.resolve();
  const snapshot = viewport.querySelector<HTMLElement>("[data-sidebar-archive-exit]");
  expect(snapshot).not.toBeNull();
  expect(snapshot!.getBoundingClientRect().bottom).toBeGreaterThan(
    viewport.getBoundingClientRect().top,
  );
  expect(snapshot!.textContent).toContain("Visible child");
});
