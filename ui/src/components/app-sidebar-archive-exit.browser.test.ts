import { expect, it, onTestFailed, onTestFinished, vi } from "vitest";
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

setupSidebarTest();

it.each([false, true])(
  "hides an archived row immediately with a presentation-only exit (reduced motion: %s)",
  async (reducedMotion) => {
    await emulateOverlayMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    onTestFinished(() => emulateOverlayMedia({ reducedMotion: "no-preference" }));
    const sessions = createSessionsHarness("main", ["agent:main:b", "agent:main:a"]);
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
    const rows = [...sidebar.querySelectorAll<HTMLElement>("[data-session-key]")];
    const row = rows[0]!;
    const archivedKey = row.dataset.sessionKey!;
    const next = rows[1]!;
    expect(next.getBoundingClientRect().top).toBeGreaterThan(row.getBoundingClientRect().top);
    const beforeTop = next.getBoundingClientRect().top;
    const tree = next.closest<HTMLElement>(".sidebar-session-tree")!;
    let observedTransform = false;
    const observeTransform = (event: TransitionEvent) => {
      if (event.target === tree && event.propertyName === "transform") {
        observedTransform = true;
      }
    };
    tree.addEventListener("transitionrun", observeTransform);
    onTestFinished(() => tree.removeEventListener("transitionrun", observeTransform));
    onTestFailed(() => {
      console.error("[sidebar-archive-motion]", {
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        observedTransform,
        retainedTree:
          sidebar
            .querySelector(`[data-session-key="${next.dataset.sessionKey}"]`)
            ?.closest(".sidebar-session-tree") === tree,
        transform: getComputedStyle(tree).transform,
        transition: getComputedStyle(tree).transition,
        exitPresent: Boolean(sidebar.querySelector("[data-sidebar-archive-exit]")),
        exitHeld: tree.parentElement?.hasAttribute("data-sidebar-archive-exiting"),
      });
    });
    const archive = row.querySelector<HTMLButtonElement>("[data-sidebar-session-archive]")!;
    expect(archive.disabled, archive.outerHTML).toBe(false);
    archive.click();
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(sessions.sessions.archiveVisibility(archivedKey)).toBe("pending"),
    );
    expect(sessions.patch).not.toHaveBeenCalled();
    await waitForSolid(() =>
      expect(sidebar.querySelector(`[data-session-key="${archivedKey}"]`)).toBeNull(),
    );
    const exit = sidebar.querySelector<HTMLElement>("[data-sidebar-archive-exit]");
    const list = next.closest<HTMLElement>(".sidebar-session-window")!;
    if (reducedMotion) {
      expect(exit).toBeNull();
      expect(list.hasAttribute("data-sidebar-archive-exiting")).toBe(false);
      await waitForSolid(() => expect(next.getBoundingClientRect().top).toBeLessThan(beforeTop));
    } else {
      expect(exit).not.toBeNull();
      expect(exit!.inert).toBe(true);
      expect(exit!.getAttribute("aria-hidden")).toBe("true");
      expect(exit!.querySelector("[data-session-key]")).toBeNull();
      expect(list.hasAttribute("data-sidebar-archive-exiting")).toBe(true);
      const [fade] = exit!.getAnimations();
      expect(fade!.effect!.getTiming().duration).toBe(240);
      // Record the transition even if its event precedes import settlement.
      await waitForSolid(() => expect(observedTransform).toBe(true));
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
      expect(list.hasAttribute("data-sidebar-archive-exiting")).toBe(false);
      expect(next.getBoundingClientRect().top).toBeLessThan(beforeTop);
    }
    await closeArchiveUndoToast();
    await waitForSolid(() => expect(sessions.patch).toHaveBeenCalledOnce());
    finishPatch(successfulSessionPatch(archivedKey));
    await sidebar.updateComplete;
  },
);
