import { expect } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";

export async function selectUsageExport(menu: Element, value: string): Promise<void> {
  const trigger = menu.querySelector<HTMLButtonElement>(".oc-menu-trigger");
  const item = menu.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
  if (!trigger || !item) {
    throw new Error(`Missing Usage export menu item ${value}`);
  }
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  item.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
}
