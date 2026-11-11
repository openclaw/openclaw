import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import "../components/sidebar-attention.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { FloatingUpdateCard } from "./navigation-surface-view.tsx";
import { navigationSurfaceIsHidden } from "./navigation-surface.ts";

describe("OpenClaw shell update affordance", () => {
  it.each([
    { mobileNavLayout: false, onboarding: false },
    { mobileNavLayout: true, onboarding: false },
    { mobileNavLayout: false, onboarding: true },
  ])("retains refresh independently of floating attention for %o", async (surface) => {
    const [refreshRequired, setRefreshRequired] = createSignal(false);
    const [navCollapsed, setNavCollapsed] = createSignal(true);
    const onRefresh = vi.fn(async () => false);
    const view = mountSolid(() => (
      <FloatingUpdateCard
        {...surface}
        navigationSurfaceHidden={navigationSurfaceIsHidden({
          ...surface,
          navCollapsed: navCollapsed(),
          navDrawerOpen: false,
        })}
        refreshRequired={refreshRequired()}
        onRefresh={onRefresh}
      />
    ));
    await vi.dynamicImportSettled();
    const attention = view.container.querySelector("openclaw-sidebar-attention");
    expect(attention !== null).toBe(!surface.mobileNavLayout && !surface.onboarding);
    setRefreshRequired(true);
    flush();
    expect(view.container.querySelector("openclaw-sidebar-attention")).toBe(attention);
    await vi.waitFor(() =>
      expect(
        view.container.querySelector(".refresh-notice__surface")?.getAttribute("aria-label"),
      ).toContain("Refresh for full capabilities"),
    );
    const card = view.container.querySelector("openclaw-sidebar-update-card");
    card!.querySelector<HTMLButtonElement>(".refresh-notice__surface")!.click();
    expect(onRefresh).toHaveBeenCalledOnce();
    setNavCollapsed(false);
    flush();
    expect(view.container.querySelector("openclaw-sidebar-attention")).toBeNull();
    expect(view.container.querySelector("openclaw-sidebar-update-card")).toBe(card);
    setRefreshRequired(false);
    flush();
    expect(view.container.querySelector("openclaw-sidebar-update-card")).toBeNull();
  });
});
