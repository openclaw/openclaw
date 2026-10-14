import type WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type { JSX } from "@solidjs/web";
import { createEffect } from "solid-js";
import { syncDropdownItemRadio } from "./web-awesome.ts";

type SessionMenuItemProps = {
  children?: JSX.Element;
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  slot?: string;
  value?: string;
  variant?: WaDropdownItem["variant"];
  disabled?: boolean;
  title?: string;
  role?: JSX.HTMLAttributes<HTMLElement>["role"];
  checked?: boolean;
  "data-shortcut"?: string;
  "data-new-tab-action"?: string;
  "aria-keyshortcuts"?: string;
  "onSubmenu-opening"?: (event: CustomEvent<{ item: HTMLElement }>) => void;
};

/** Web Awesome owns menu navigation; radio rows restore semantics after its upgrade. */
export function SessionMenuItem(props: SessionMenuItemProps) {
  let element: WaDropdownItem | undefined;
  createEffect(
    () => props.checked,
    (checked) => {
      if (checked !== undefined) {
        syncDropdownItemRadio(element, checked);
      }
    },
  );
  return (
    <wa-dropdown-item
      ref={(node) => {
        element = node;
      }}
      class={props.class}
      slot={props.slot}
      value={props.value}
      variant={props.variant ?? "default"}
      prop:disabled={props.disabled ?? false}
      title={props.title}
      role={props.checked === undefined ? props.role : "menuitemradio"}
      aria-checked={props.checked === undefined ? undefined : props.checked ? "true" : "false"}
      data-shortcut={props["data-shortcut"]}
      data-new-tab-action={props["data-new-tab-action"]}
      aria-keyshortcuts={props["aria-keyshortcuts"]}
      onSubmenu-opening={(event) => props["onSubmenu-opening"]?.(event)}
    >
      {props.children}
    </wa-dropdown-item>
  );
}
