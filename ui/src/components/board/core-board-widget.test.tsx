import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import {
  cancelStaleChunkRecovery,
  installStaleChunkReloadListener,
  scheduleStaleChunkReload,
} from "../../app/stale-chunk-reload.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { getPluginWidgetKindContribution } from "../../lib/board/widgets/index.ts";
import * as storageAccess from "../../local-storage.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { CoreBoardWidget } from "./core-board-widget.tsx";

const staleError = vi.hoisted(() => new TypeError("Failed to fetch dynamically imported module"));
// mock-isolation: Fail the lazy renderer without starting its real report host or subscriptions.
vi.mock("../../lib/board/widgets/report.tsx", () => ({
  ReportWidget: () => {
    throw staleError;
  },
}));

afterEach(() => {
  cancelStaleChunkRecovery();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it.each(["hide", "dispose"] as const)(
  "retires automatic stale recovery when the failed widget is removed by %s",
  async (retirement) => {
    const [active, setActive] = createSignal(true);
    const contribution = getPluginWidgetKindContribution("session:report", [
      { pluginId: "session", kind: "session:report", label: "Report" },
    ])!;
    const widget: BoardWidget = {
      name: "report",
      tabId: "main",
      contentKind: "plugin",
      pluginKind: "session:report",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const mounted = mountSolid(() => (
      <CoreBoardWidget widget={widget} contribution={contribution} active={active()} />
    ));
    await waitForSolid(() => expect(mounted.container.textContent).toContain("Reload"));

    vi.useFakeTimers();
    vi.spyOn(storageAccess, "getSafeSessionStorage").mockReturnValue(sessionStorage);
    const probe = Promise.withResolvers<Response>();
    const fetchDocument = vi.fn<typeof fetch>(() => probe.promise);
    vi.stubGlobal("fetch", fetchDocument);
    const originalWindow = window;
    const reload = vi.fn();
    vi.stubGlobal("window", {
      location: { href: originalWindow.location.href, replace: reload },
      addEventListener: originalWindow.addEventListener.bind(originalWindow),
      removeEventListener: originalWindow.removeEventListener.bind(originalWindow),
      dispatchEvent: originalWindow.dispatchEvent.bind(originalWindow),
    });
    const uninstall = installStaleChunkReloadListener();
    try {
      window.dispatchEvent(Object.assign(new Event("vite:preloadError"), { payload: staleError }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchDocument).toHaveBeenCalledOnce();
      const recovery = scheduleStaleChunkReload({ reload });

      if (retirement === "hide") {
        setActive(false);
        flush();
      } else {
        mounted.unmount();
      }
      probe.resolve(new Response(null, { status: 200 }));
      await expect(recovery).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
      if (retirement === "hide") {
        setActive(true);
        flush();
        expect(mounted.container.textContent).toContain("Reload");
      }
    } finally {
      uninstall();
      mounted.unmount();
    }
  },
);
