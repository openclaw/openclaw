/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatDashboardMenu } from "./chat-header-panel-actions.tsx";

afterEach(() => vi.restoreAllMocks());

it.each([
  { expanded: false, label: "Expand Dashboard" },
  { expanded: true, label: "Restore split" },
])("activates $label on its first DOM observation while opening", async ({ expanded, label }) => {
  // Keep presentation in opening; activation must not depend on a later frame.
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const onLayoutChange = vi.fn();
  const mount = () =>
    mountSolid(() => (
      <ChatDashboardMenu
        paneId="readiness"
        narrow={false}
        mobile={false}
        sidebarLayout={{
          mainPanelId: "dashboard",
          open: true,
          expanded,
          columns: [
            {
              id: "column",
              side: "right",
              panels: [
                { id: "dashboard", slot: "dashboard" },
                { id: "conversation", slot: "conversation" },
              ],
              activePanelId: "conversation",
              width: 480,
              height: 360,
            },
          ],
        }}
        onLayoutChange={onLayoutChange}
      />
    ));
  // Resolve the production lazy component in a separate mount, so the target's
  // first opening takes the warm-content path independently of test ordering.
  const primer = mount();
  primer.container.querySelector<HTMLButtonElement>(".chat-dashboard-menu__trigger")!.click();
  await vi.dynamicImportSettled();
  flush();
  expect(primer.container.querySelector('[data-value="dashboard-expand"]')).not.toBeNull();
  primer.unmount();

  const view = mount();
  const surface = view.container.querySelector<HTMLElement>('[role="menu"]')!;
  const trigger = view.container.querySelector<HTMLButtonElement>(".chat-dashboard-menu__trigger")!;
  const selected = vi.fn();
  surface.addEventListener("menu-select", selected);
  onTestFinished(() => surface.removeEventListener("menu-select", selected));

  const firstActivation = new Promise<{
    connected: boolean;
    disabled: boolean;
    open: boolean;
    expanded: string | null;
    phase: string | undefined;
    label: string | null;
  }>((resolve) => {
    const observer = new MutationObserver(() => {
      const item = surface.querySelector<HTMLButtonElement>('[data-value="dashboard-expand"]');
      if (!item || item.disabled) {
        return;
      }
      observer.disconnect();
      const before = {
        connected: item.isConnected,
        disabled: item.disabled,
        open: surface.matches(":popover-open"),
        expanded: trigger.getAttribute("aria-expanded"),
        phase: surface.dataset.phase,
        label: item.getAttribute("aria-label"),
      };
      item.click();
      resolve(before);
    });
    observer.observe(surface, { childList: true, subtree: true, attributes: true });
    onTestFinished(() => observer.disconnect());
  });

  // No frame is delivered for this opening: the earliest actionable row must work.
  trigger.click();
  expect(await firstActivation).toEqual({
    connected: true,
    disabled: false,
    open: true,
    expanded: "true",
    phase: "opening",
    label,
  });
  expect(selected).toHaveBeenCalledOnce();
  expect(onLayoutChange).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ expanded: !expanded }),
    { dashboardPresentation: "personal" },
  );
  expect(surface.matches(":popover-open")).toBe(false);
});
