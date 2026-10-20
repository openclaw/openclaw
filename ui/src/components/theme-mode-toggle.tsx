import type { ThemeMode } from "../app/theme.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";
import type { MenuItemBindings } from "./solid/menu.tsx";
import "./tooltip.ts";

type Props = {
  mode: ThemeMode;
  menuItem: boolean;
  menuAttributes?: MenuItemBindings;
  onChange?: (mode: ThemeMode, element: HTMLElement) => void;
};

defineSolidBridge<Props>(
  "openclaw-theme-mode-toggle",
  (props, host) => {
    host.style.display = "contents";
    const label = () =>
      t(`common.${props.mode === "system" ? "system" : props.mode === "light" ? "light" : "dark"}`);
    const tooltip = () => t("common.colorModeOption", { mode: label() });
    return (
      <openclaw-tooltip prop:content={tooltip()}>
        <button
          {...props.menuAttributes}
          type="button"
          class="theme-mode-toggle"
          role={props.menuItem ? "menuitem" : undefined}
          aria-label={tooltip()}
          onClick={(event) => {
            props.onChange?.(
              props.mode === "system" ? "light" : props.mode === "light" ? "dark" : "system",
              event.currentTarget,
            );
            const onClick = props.menuAttributes?.onClick;
            if (typeof onClick === "function") {
              onClick(event);
            }
          }}
        >
          <Icon
            name={props.mode === "system" ? "monitor" : props.mode === "light" ? "sun" : "moon"}
          />
        </button>
      </openclaw-tooltip>
    );
  },
  {
    properties: {
      mode: { default: "system", attribute: false },
      menuItem: { default: false, attribute: false },
      menuAttributes: { default: undefined, attribute: false },
      onChange: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-theme-mode-toggle": SolidBridgeElement<Props>;
  }
}
