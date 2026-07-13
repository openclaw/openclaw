// Register only the Web Awesome Core elements used by the Control UI.
// Per-component imports keep the production bundle tree-shakeable.
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/radio/radio.js";
import "@awesome.me/webawesome/dist/components/radio-group/radio-group.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";

// Web Awesome labels its trigger but leaves the internal menu unnamed. Copy
// the host label, or reference the trigger, when the popup enters the a11y tree.
function labelDropdownMenu(event: Event) {
  const dropdown = event.target;
  if (!(dropdown instanceof HTMLElement) || dropdown.localName !== "wa-dropdown") {
    return;
  }
  const menu = dropdown.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
  if (!menu) {
    return;
  }
  const label = dropdown.getAttribute("aria-label");
  if (label) {
    menu.setAttribute("aria-label", label);
    menu.removeAttribute("aria-labelledby");
    return;
  }
  const trigger = dropdown.querySelector<HTMLElement>('[slot="trigger"]');
  if (trigger?.id) {
    menu.setAttribute("aria-labelledby", trigger.id);
    menu.removeAttribute("aria-label");
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("wa-show", labelDropdownMenu);
}
