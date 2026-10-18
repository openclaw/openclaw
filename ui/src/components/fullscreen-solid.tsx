import { t } from "../lib/reactive/i18n.ts";
import type { DesktopFullscreenController } from "./fullscreen-controller.ts";
import { Icon } from "./solid/icon.tsx";
import "./tooltip.ts";

export function FullscreenButton(props: { controller: DesktopFullscreenController }) {
  const label = () =>
    t(
      props.controller.active
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
        aria-pressed={props.controller.active ? "true" : "false"}
        aria-disabled={props.controller.supported() ? "false" : "true"}
        onClick={() => void props.controller.toggle()}
      >
        <span class="desktop-fullscreen-icon" aria-hidden="true">
          <Icon name={props.controller.active ? "minimize" : "maximize"} />
        </span>
      </button>
    </openclaw-tooltip>
  );
}
