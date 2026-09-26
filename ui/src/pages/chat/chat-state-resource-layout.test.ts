import { expect, it, vi } from "vitest";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import { createChatPageStateContext } from "./chat-page.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { openSlot } from "./sidebar-layout.ts";

it.each(["minimize", "close-resource", "explicit-desktop"])(
  "preserves resource layout intent through %s",
  (action) => {
    const savedSettings = loadSettings();
    saveSettings({ ...savedSettings, sidebarSessionLayouts: {} });
    try {
      const context = createChatPageStateContext();
      const renderLifecycle = { invalidate: vi.fn(), afterCommit: () => () => {} };
      const host = {
        dispatchEvent: () => true,
        getBoundingClientRect: () => new DOMRect(0, 0, 1440, 900),
        querySelector: () => null,
      };
      const state = createPageState(context, renderLifecycle, host);
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "desktop"), {
        persist: false,
        automaticResource: "desktop",
      });
      const beforeDismissalReload = createPageState(context, renderLifecycle, host);
      expect(beforeDismissalReload.sidebarLayout.columns).toEqual([]);
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "browser"), {
        persist: false,
        automaticResource: "browser",
      });
      state.updateSidebarLayout({ ...openSlot(state.sidebarLayout, "workspace"), dock: "bottom" });
      const afterLayoutChange = createPageState(context, renderLifecycle, host);
      expect(
        afterLayoutChange.sidebarLayout.columns.flatMap((column) =>
          column.panels.map((panel) => panel.slot),
        ),
      ).toEqual(["workspace"]);
      expect(afterLayoutChange.sidebarLayout.dock).toBe("bottom");
      expect(state.sidebarLayout.resourceAutoOpenDismissed).toBeUndefined();
      if (action === "explicit-desktop") {
        const explicit = openSlot(state.sidebarLayout, "desktop");
        for (const panel of explicit.columns.flatMap((column) => column.panels)) {
          if (panel.slot === "desktop") {
            panel.environmentId = "manual-desktop";
          }
        }
        state.updateSidebarLayout(explicit);
        const reloaded = createPageState(context, renderLifecycle, host);
        const panels = reloaded.sidebarLayout.columns.flatMap((column) => column.panels);
        expect(panels.find((panel) => panel.slot === "desktop")).toMatchObject({
          environmentId: "manual-desktop",
        });
        expect(panels.some((panel) => panel.slot === "browser")).toBe(false);
        expect(reloaded.sidebarLayout.resourceAutoOpenDismissed).toBeUndefined();
        return;
      }
      if (action === "minimize") {
        state.updateSidebarLayout({ ...state.sidebarLayout, open: false });
      } else {
        state.updateSidebarLayout({ ...state.sidebarLayout, columns: [] });
      }
      expect(state.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      const reloaded = createPageState(context, renderLifecycle, host);
      expect(reloaded.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "browser"));
      expect(state.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      expect(state.sidebarLayout.open).toBe(true);
    } finally {
      saveSettings(savedSettings);
    }
  },
);
