import { afterEach, describe, expect, it, vi } from "vitest";
import "../components/sidebar-attention.tsx";
import "../styles.css";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { FloatingUpdateCard } from "./navigation-surface-view.tsx";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
});

async function useDesktopViewport() {
  const { page } = await import("vitest/browser");
  await page.viewport(1280, 800);
}

function overlaps(left: DOMRect, right: DOMRect): boolean {
  return !(
    left.right <= right.left ||
    left.left >= right.right ||
    left.bottom <= right.top ||
    left.top >= right.bottom
  );
}

describe.skipIf(!hasBrowserLayout)("navigation surface browser layout", () => {
  it("keeps the floating refresh card clear of the collapsed chrome cluster", async () => {
    await useDesktopViewport();
    mountSolid(() => (
      <div
        class="shell shell--navigation-rail shell--nav-collapsed"
        style="animation: none; --shell-nav-rail-width: 52px"
      >
        <div class="shell-chrome-controls">
          <button
            class="shell-chrome-controls__button shell-chrome-controls__search"
            type="button"
            aria-label="Search"
          ></button>
        </div>
        <main class="content">
          <FloatingUpdateCard
            navigationSurfaceHidden={true}
            mobileNavLayout={false}
            onboarding={false}
            refreshRequired={true}
            onRefresh={async () => false}
          />
        </main>
      </div>
    ));

    await vi.dynamicImportSettled();
    expect(document.querySelector(".sidebar-update-card")).not.toBeNull();
    const refreshCardHost = document.querySelector("openclaw-sidebar-update-card");
    const attentionHost = document.querySelector<
      HTMLElement & { updateComplete: Promise<boolean> }
    >("openclaw-sidebar-attention");
    await attentionHost?.updateComplete;
    expect(attentionHost).not.toBeNull();
    expect(attentionHost?.querySelector(".sidebar-issues-button")).toBeNull();
    const refreshCard = refreshCardHost?.querySelector<HTMLElement>(".sidebar-update-card");
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>(".shell-chrome-controls__button"),
    );
    expect(refreshCard).not.toBeNull();
    expect(buttons).toHaveLength(1);

    const cardBounds = refreshCard!.getBoundingClientRect();
    const buttonBounds = buttons.map((button) => button.getBoundingClientRect());
    expect(cardBounds.width).toBeGreaterThan(0);
    for (const bounds of buttonBounds) {
      expect(bounds.width).toBeGreaterThan(0);
      expect(overlaps(cardBounds, bounds)).toBe(false);
    }
    expect(
      cardBounds.left - Math.max(...buttonBounds.map((bounds) => bounds.right)),
    ).toBeGreaterThanOrEqual(8);
  });
});
