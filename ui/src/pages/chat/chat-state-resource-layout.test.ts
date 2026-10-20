import { expect, it } from "vitest";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import { createChatPageStateContext } from "./chat-page.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { activatePanel, openSlot } from "./sidebar-layout.ts";

function page(context = createChatPageStateContext(), height = 900) {
  return createPageState(
    context,
    { afterCommit: () => () => {} },
    {
      dispatchEvent: () => true,
      getBoundingClientRect: () => new DOMRect(0, 0, 1440, height),
    },
  );
}
const panels = (state: ReturnType<typeof page>) =>
  state.sidebarLayout.columns.flatMap((column) => column.panels);
const slots = (state: ReturnType<typeof page>) => panels(state).map((panel) => panel.slot);

it.each(["minimize", "close-resource", "explicit-desktop"])(
  "preserves resource layout intent through %s",
  (action) => {
    const savedSettings = loadSettings();
    saveSettings({ ...savedSettings, sidebarSessionLayouts: {} });
    try {
      const context = createChatPageStateContext();
      const state = page(context);
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "desktop"), {
        persist: false,
        automaticResource: "desktop",
      });
      const beforeDismissalReload = page(context);
      expect(beforeDismissalReload.sidebarLayout.columns).toEqual([]);
      state.updateSidebarLayout({ ...openSlot(state.sidebarLayout, "workspace"), dock: "bottom" });
      const afterLayoutChange = page(context);
      expect(slots(afterLayoutChange)).toEqual(["workspace"]);
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
        const reloaded = page(context);
        expect(panels(reloaded).find((panel) => panel.slot === "desktop")).toMatchObject({
          environmentId: "manual-desktop",
        });
        expect(slots(reloaded)).not.toContain("browser");
        expect(reloaded.sidebarLayout.resourceAutoOpenDismissed).toBeUndefined();
        return;
      }
      if (action === "minimize") {
        state.updateSidebarLayout({ ...state.sidebarLayout, open: false });
      } else {
        state.updateSidebarLayout({ ...state.sidebarLayout, columns: [] });
      }
      expect(state.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      const reloaded = page(context);
      expect(reloaded.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "browser"));
      expect(state.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
      expect(state.sidebarLayout.open).toBe(true);
    } finally {
      saveSettings(savedSettings);
    }
  },
);

it("owns attachment views in Files without replacing Detail content", () => {
  const state = page(undefined, 0);
  const detailContent = {
    kind: "markdown" as const,
    content: "Existing review",
    rawText: "Existing review",
  };
  state.sidebarContent = detailContent;
  state.sidebarLayout = openSlot(state.sidebarLayout, "detail");

  state.handleOpenSidebar({
    kind: "attachment",
    attachmentKind: "document",
    title: "report.pdf",
    src: "/media/report.pdf",
  });

  expect(slots(state)).toEqual(["detail", "workspace"]);
  expect(state.sessionWorkspaceState?.previews.at(-1)?.content.kind).toBe("attachment");
  expect(state.sidebarContent).toBe(detailContent);

  state.sidebarLayout = activatePanel(state.sidebarLayout, "detail");
  state.handleCloseSidebar("detail");

  expect(slots(state)).toEqual(["workspace"]);
  expect(state.sessionWorkspaceState?.previews.at(-1)?.content.kind).toBe("attachment");
  expect(state.sidebarContent).toBe(detailContent);

  state.handleCloseSidebar("workspace");

  expect(panels(state)).toHaveLength(0);
  expect(state.sessionWorkspaceState?.previews ?? []).toEqual([]);
  expect(state.sidebarContent).toBe(detailContent);
});
