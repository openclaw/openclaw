import { beforeEach, expect, it, onTestFinished } from "vitest";
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
beforeEach(() => {
  const saved = loadSettings();
  onTestFinished(() => saveSettings(saved));
  saveSettings({ ...saved, sidebarSessionLayouts: {} });
});

it.each(["minimize", "close-resource", "explicit-desktop"])(
  "preserves resource layout intent through %s",
  (action) => {
    const context = createChatPageStateContext();
    const state = page(context);
    state.updateSidebarLayout(openSlot(state.sidebarLayout, "desktop"), {
      persist: false,
      automaticResource: "desktop",
    });
    expect(page(context).sidebarLayout.columns).toEqual([]);
    state.updateSidebarLayout({ ...openSlot(state.sidebarLayout, "workspace"), dock: "bottom" });
    const afterLayoutChange = page(context);
    expect(slots(afterLayoutChange)).toEqual(["workspace"]);
    expect(afterLayoutChange.sidebarLayout.dock).toBe("bottom");
    expect(state.sidebarLayout.resourceAutoOpenDismissed).toBeUndefined();
    if (action === "explicit-desktop") {
      const explicit = openSlot(state.sidebarLayout, "desktop");
      explicit.columns
        .flatMap((column) => column.panels)
        .find((panel) => panel.slot === "desktop")!.environmentId = "manual-desktop";
      state.updateSidebarLayout(explicit);
      const reloaded = page(context);
      expect(panels(reloaded).find((panel) => panel.slot === "desktop")).toMatchObject({
        environmentId: "manual-desktop",
      });
      expect(slots(reloaded)).not.toContain("browser");
      expect(reloaded.sidebarLayout.resourceAutoOpenDismissed).toBeUndefined();
      return;
    }
    state.updateSidebarLayout({
      ...state.sidebarLayout,
      ...(action === "minimize" ? { open: false } : { columns: [] }),
    });
    expect(state.sidebarLayout.resourceAutoOpenDismissed).toBe(true);
    expect(page(context).sidebarLayout.resourceAutoOpenDismissed).toBe(true);
    state.updateSidebarLayout(openSlot(state.sidebarLayout, "browser"));
    expect(state.sidebarLayout).toMatchObject({ resourceAutoOpenDismissed: true, open: true });
  },
);

it("owns attachment views in Files without replacing Detail content", () => {
  const state = page(undefined, 0);
  const detailContent = {
    kind: "markdown" as const,
    content: "review",
    rawText: "review",
  };
  state.sidebarContent = detailContent;
  state.sidebarLayout = openSlot(state.sidebarLayout, "detail");

  state.handleOpenSidebar({
    kind: "attachment",
    attachmentKind: "document",
    title: "a.pdf",
    src: "/a.pdf",
  });

  for (const [slot, expected] of [
    ["detail", ["detail", "workspace"]],
    ["workspace", ["workspace"]],
  ] as const) {
    expect(slots(state)).toEqual(expected);
    expect(state.sessionWorkspaceState?.previews.at(-1)?.content.kind).toBe("attachment");
    expect(state.sidebarContent).toBe(detailContent);
    if (slot === "detail") {
      state.sidebarLayout = activatePanel(state.sidebarLayout, slot);
    }
    state.handleCloseSidebar(slot);
  }
  expect(panels(state)).toHaveLength(0);
  expect(state.sessionWorkspaceState?.previews ?? []).toEqual([]);
  expect(state.sidebarContent).toBe(detailContent);
});
