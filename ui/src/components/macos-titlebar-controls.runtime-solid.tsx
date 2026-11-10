import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { Icon, type IconName } from "./solid/icon.tsx";
import "./tooltip.ts";

type Props = {
  historyOnly: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

function TitlebarButton(props: {
  label: string;
  icon: IconName;
  disabled?: boolean;
  onClick?: () => void;
  class: string;
}) {
  return (
    <openclaw-tooltip prop:content={props.label}>
      <button
        type="button"
        class={["topbar-icon-btn macos-titlebar-controls__button", props.class]}
        aria-label={props.label}
        disabled={props.disabled || !props.onClick}
        onClick={() => props.onClick?.()}
      >
        <Icon name={props.icon} />
      </button>
    </openclaw-tooltip>
  );
}

export const MacosTitlebarControls = defineSolidBridge<Props>(
  "openclaw-macos-titlebar-controls",
  (props, host) => {
    host.style.display = "contents";
    return (
      <nav
        class={[
          "macos-titlebar-controls",
          { "macos-titlebar-controls--history-only": props.historyOnly },
        ]}
        onMouseDown={beginNativeWindowDrag}
      >
        <TitlebarButton
          label={t("nav.back")}
          icon="chevronLeft"
          disabled={!props.canGoBack}
          onClick={() => globalThis.history.back()}
          class="macos-titlebar-controls__back"
        />
        <TitlebarButton
          label={t("nav.forward")}
          icon="chevronRight"
          disabled={!props.canGoForward}
          onClick={() => globalThis.history.forward()}
          class="macos-titlebar-controls__forward"
        />
      </nav>
    );
  },
  {
    properties: {
      historyOnly: { default: false, attribute: false },
      canGoBack: { default: false, attribute: false },
      canGoForward: { default: false, attribute: false },
    },
  },
);
