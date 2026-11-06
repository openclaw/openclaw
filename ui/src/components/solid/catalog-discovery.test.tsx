import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { CatalogDiscoverySection } from "./catalog-discovery.tsx";

it("uses the current view-all action without replacing the focused button", () => {
  const initial = vi.fn();
  const current = vi.fn();
  const [updated, setUpdated] = createSignal(false);
  const view = mountSolid(() => (
    <CatalogDiscoverySection
      id="featured"
      title="Featured"
      viewAllLabel="View all"
      onViewAll={updated() ? current : initial}
    >
      <p>Featured catalog entries</p>
    </CatalogDiscoverySection>
  ));
  const button = view.getByRole("button", { name: "View all" });
  button.focus();
  setUpdated(true);
  flush();
  button.click();
  expect(current).toHaveBeenCalledOnce();
  expect(initial).not.toHaveBeenCalled();
  expect(view.getByRole("button", { name: "View all" })).toBe(button);
  expect(document.activeElement).toBe(button);
});
