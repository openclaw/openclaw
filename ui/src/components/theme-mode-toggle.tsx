import type { ThemeMode } from "../app/theme.ts";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";
import type { MenuItemBindings } from "./solid/menu.tsx";
import "./tooltip.ts";

type Props = {
  mode: ThemeMode;
  menuAttributes?: MenuItemBindings;
  onChange?: (mode: ThemeMode, element: HTMLElement) => void;
};

export function ThemeModeToggle(props: Props) {
  const label = () =>
    t(`common.${props.mode === "system" ? "system" : props.mode === "light" ? "light" : "dark"}`);
  const tooltip = () => t("common.colorModeOption", { mode: label() });
  return (
    <openclaw-theme-mode-toggle style={{ display: "contents" }}>
      <openclaw-tooltip prop:content={tooltip()}>
        <button
          {...props.menuAttributes}
          type="button"
          class="theme-mode-toggle"
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
    </openclaw-theme-mode-toggle>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-theme-mode-toggle": HTMLAttributes<HTMLElement>;
    }
  }
}
