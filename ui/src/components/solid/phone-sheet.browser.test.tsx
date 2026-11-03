import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { phase } from "../../test-helpers/solid-menu.tsx";
import { PhoneSheet } from "./phone-sheet.tsx";
import type { PopoverHandle } from "./popover.tsx";

afterEach(cleanup);

function mountSheet() {
  let handle!: PopoverHandle;
  const view = render(() => (
    <form data-testid="form">
      <PhoneSheet id="filters-sheet" label="Filters" ref={(next) => (handle = next)}>
        <input name="provider" aria-label="Provider" value="slack" />
        <button type="submit">Filter</button>
      </PhoneSheet>
      <button type="button">Outside</button>
    </form>
  ));
  flush();
  const surface = handle.overlay.surface;
  const part = (name: string) => surface.querySelector<HTMLElement>(`.oc-sheet__${name}`)!;
  return { view, handle, surface, part };
}

describe("PhoneSheet", () => {
  it("keeps its fields in the form while closed", () => {
    const { view } = mountSheet();
    const form = view.getByTestId("form") as HTMLFormElement;
    expect(new FormData(form).get("provider")).toBe("slack");
  });

  it("opens from its trigger as a modal with focus off the fields", async () => {
    const { view, surface, part } = mountSheet();
    await userEvent.click(view.getByRole("button", { name: "Filters" }));
    await phase(surface, "open");
    expect(surface.getAttribute("aria-modal")).toBe("true");
    expect(part("title").textContent).toBe("Filters");
    expect(document.activeElement).toBe(part("close"));
  });

  it("slides away from the backdrop and reopens where it belongs", async () => {
    const { view, handle, surface, part } = mountSheet();
    const trigger = view.getByRole("button", { name: "Filters" });
    await userEvent.click(trigger);
    await phase(surface, "open");
    await userEvent.click(part("backdrop"));
    await phase(surface, "hidden");
    expect(handle.overlay.open).toBe(false);
    expect(document.activeElement).toBe(trigger);

    await userEvent.click(trigger);
    await phase(surface, "open");
    await userEvent.click(part("close"));
    await phase(surface, "hidden");
    expect(handle.overlay.open).toBe(false);
  });

  it("ignores a hide while closed, so the next opening stays open", async () => {
    const { view, handle, surface } = mountSheet();
    expect(handle.hide()).toBe(false);
    await userEvent.click(view.getByRole("button", { name: "Filters" }));
    await phase(surface, "open");
    expect(handle.overlay.open).toBe(true);
  });

  it("wraps Tab between its first and last controls", async () => {
    const { view, surface, part } = mountSheet();
    await userEvent.click(view.getByRole("button", { name: "Filters" }));
    await phase(surface, "open");
    const last = view.getByRole("button", { name: "Filter" });
    last.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(part("close"));
  });
});
