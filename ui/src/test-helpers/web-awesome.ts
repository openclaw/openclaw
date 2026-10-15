import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type { ReactiveElement } from "lit";

export async function settleWebAwesome(root: ParentNode): Promise<void> {
  for (const element of root.querySelectorAll<ReactiveElement>(
    "wa-dropdown, wa-dropdown-item, wa-popup",
  )) {
    await element.updateComplete;
    if (element.shadowRoot) {
      await settleWebAwesome(element.shadowRoot);
    }
  }
}

export async function openDetails(details: HTMLDetailsElement): Promise<void> {
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await settleWebAwesome(details);
}

export async function openDropdownSubmenu(item: WaDropdownItem): Promise<void> {
  const parent = item.parentElement?.closest<WaDropdownItem>("wa-dropdown-item");
  if (parent) {
    await openDropdownSubmenu(parent);
  }
  await item.openSubmenu();
}
