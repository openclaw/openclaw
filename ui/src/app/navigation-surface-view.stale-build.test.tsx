import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { FloatingUpdateCard } from "./navigation-surface-view.tsx";

// mock-isolation: a Gateway replaced by a newer build answers 404 for this tab's card chunk.
vi.mock("../components/sidebar-update-card.tsx", () => {
  throw new TypeError(
    "Failed to fetch dynamically imported module: /assets/sidebar-update-card.js",
  );
});

describe("OpenClaw shell refresh notice", () => {
  it("still offers Reload when this tab's notice chunk is gone", async () => {
    const onRefresh = vi.fn(async () => false);
    const view = mountSolid(() => (
      <FloatingUpdateCard
        navigationSurfaceHidden={false}
        mobileNavLayout={false}
        onboarding={false}
        refreshRequired
        onRefresh={onRefresh}
      />
    ));
    const reload = await vi.waitFor(() => {
      const button = [...view.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Reload",
      );
      expect(button).toBeDefined();
      return button!;
    });
    expect(view.container.textContent).toContain("OpenClaw was updated");
    reload.click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
