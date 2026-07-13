/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { shouldRestoreDropdownTriggerFocus } from "./web-awesome.ts";

type DropdownElement = HTMLElement & { readonly updateComplete: Promise<unknown> };

async function createDropdown(label?: string) {
  const dropdown = document.createElement("wa-dropdown") as DropdownElement;
  if (label) {
    dropdown.setAttribute("aria-label", label);
  }
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "Actions";
  const item = document.createElement("wa-dropdown-item");
  item.textContent = "Open";
  dropdown.append(trigger, item);
  document.body.append(dropdown);
  await dropdown.updateComplete;
  dropdown.dispatchEvent(new CustomEvent("wa-show", { bubbles: true, composed: true }));
  return { dropdown, trigger };
}

afterEach(() => document.body.replaceChildren());

describe("Web Awesome adapters", () => {
  it("copies an explicit dropdown label to the menu", async () => {
    const { dropdown } = await createDropdown("Message actions");

    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
      "Message actions",
    );
  });

  it("labels a dropdown menu from its trigger", async () => {
    const { dropdown, trigger } = await createDropdown();

    expect(trigger.id).not.toBe("");
    expect(
      dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-labelledby"),
    ).toBe(trigger.id);
  });

  it("restores a durable trigger only after keyboard dismissal", async () => {
    const { dropdown, trigger } = await createDropdown();
    const outside = document.createElement("input");
    document.body.append(outside);
    let restoreFocus = false;
    dropdown.addEventListener("wa-after-hide", (event) => {
      restoreFocus = shouldRestoreDropdownTriggerFocus(event);
    });

    trigger.focus();
    dropdown.dispatchEvent(new CustomEvent("wa-after-hide"));
    expect(restoreFocus).toBe(true);

    outside.focus();
    dropdown.dispatchEvent(new CustomEvent("wa-after-hide"));
    expect(restoreFocus).toBe(false);
  });
});
