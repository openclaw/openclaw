import { t } from "../lib/reactive/i18n.ts";
import type { DesktopFullscreen } from "./desktop-fullscreen.ts";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";

export function FullscreenButton(props: { controller: DesktopFullscreen }) {
  const label = () =>
    t(
      props.controller.active()
        ? "desktop.exitFullscreen"
        : props.controller.supported()
          ? "desktop.enterFullscreen"
          : "desktop.fullscreenUnavailable",
    );
  return (
    <openclaw-tooltip prop:content={label()}>
      <button
        class="bp-icon desktop-fullscreen-button"
        type="button"
        aria-label={label()}
        aria-pressed={props.controller.active() ? "true" : "false"}
        aria-disabled={props.controller.supported() ? "false" : "true"}
        onClick={(event) => void props.controller.toggle(event.currentTarget)}
      >
        <span class="desktop-fullscreen-icon" aria-hidden="true">
          <Icon name={props.controller.active() ? "minimize" : "maximize"} />
        </span>
      </button>
    </openclaw-tooltip>
  );
}
