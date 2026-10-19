import type { SidebarLifecycleState } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";

export function sidebarDriver(sidebar: SidebarLifecycleState) {
  const dom = domProbe(sidebar);
  return {
    ...dom,
    update(properties: Partial<SidebarLifecycleState> = {}) {
      Object.assign(sidebar, properties);
      return sidebar.updateComplete;
    },
    click(target: string | HTMLElement) {
      (typeof target === "string" ? dom.query<HTMLElement>(target)! : target).click();
      return sidebar.updateComplete;
    },
    key(target: HTMLElement | null | undefined, key: string, init: KeyboardEventInit = {}) {
      target?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }),
      );
      return sidebar.updateComplete;
    },
  };
}
