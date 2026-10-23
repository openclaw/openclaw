import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import "../components/sidebar-attention.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { FloatingUpdateCard } from "./navigation-surface-view.tsx";
import { navigationSurfaceIsHidden } from "./navigation-surface.ts";

describe("OpenClaw shell update affordance", () => {
  it("keeps floating attention mounted while stale-client refresh changes", async () => {
    const [refreshRequired, setRefreshRequired] = createSignal(false);
    const [navCollapsed, setNavCollapsed] = createSignal(true);
    const onRefresh = vi.fn(async () => false);
    const view = mountSolid(() => (
      <FloatingUpdateCard
        navigationSurfaceHidden={navigationSurfaceIsHidden({
          onboarding: false,
          navCollapsed: navCollapsed(),
          navDrawerOpen: false,
          mobileNavLayout: false,
        })}
        mobileNavLayout={false}
        onboarding={false}
        refreshRequired={refreshRequired()}
        onRefresh={onRefresh}
      />
    ));
    await vi.dynamicImportSettled();
    const attention = view.container.querySelector("openclaw-sidebar-attention");
    expect(attention).not.toBeNull();
    expect(view.container.querySelector("openclaw-sidebar-update-card")).toBeNull();
    setRefreshRequired(true);
    flush();
    expect(view.container.querySelector("openclaw-sidebar-attention")).toBe(attention);
    await vi.waitFor(() =>
      expect(view.container.querySelector(".sidebar-update-card__action")).not.toBeNull(),
    );
    const card = view.container.querySelector("openclaw-sidebar-update-card");
    card!.querySelector<HTMLButtonElement>(".sidebar-update-card__action")!.click();
    expect(onRefresh).toHaveBeenCalledOnce();
    setNavCollapsed(false);
    flush();
    expect(view.container.querySelector("openclaw-sidebar-attention")).toBeNull();
    expect(view.container.querySelector("openclaw-sidebar-update-card")).toBe(card);
  });

  it.each([
    { mobileNavLayout: true, onboarding: false },
    { mobileNavLayout: false, onboarding: true },
  ])("keeps stale-client refresh without floating attention for %o", async (surface) => {
    const [refreshRequired, setRefreshRequired] = createSignal(true);
    const view = mountSolid(() => (
      <FloatingUpdateCard
        {...surface}
        navigationSurfaceHidden
        refreshRequired={refreshRequired()}
        onRefresh={async () => false}
      />
    ));
    expect(view.container.querySelector("openclaw-sidebar-attention")).toBeNull();
    await vi.waitFor(() =>
      expect(view.container.textContent).toContain("Refresh for full capabilities"),
    );
    expect(view.container.querySelector(".sidebar-update-card__action")).not.toBeNull();
    setRefreshRequired(false);
    flush();
    expect(view.container.querySelector("openclaw-sidebar-update-card")).toBeNull();
  });
});
