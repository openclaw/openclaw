import type { JSX } from "@solidjs/web";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import {
  DesktopLoading,
  DesktopPanelContent,
  DesktopSizing,
  type DesktopSizingOptions,
} from "./desktop-panel-view.tsx";

registerEnglishCatalog(registerDesktopEnglish);

type DesktopDocumentViewOptions = Omit<Parameters<typeof DesktopPanelContent>[0], "connection"> & {
  controlling: boolean;
  sizing: DesktopSizingOptions;
  keyboardInputValue: string;
  pictureInPictureControl: JSX.Element;
  audioControl?: JSX.Element;
  onControlToggle: () => void;
  onKeyboardFocus: (event: MouseEvent) => void;
  onKeyboardEvent: (event: KeyboardEvent) => void;
  onKeyboardInput: (event: InputEvent) => void;
  onClose: () => void;
};

export function DesktopDocumentView(props: DesktopDocumentViewOptions) {
  return (
    <section class="desktop-document" aria-label={t("desktop.title")}>
      <DesktopPanelContent
        {...props}
        connection={() => (
          <div class="desktop-stage">
            {/* noVNC owns this island; controls remain Solid-owned siblings. */}
            <div class="desktop-surface" />
            {props.state === "connecting" && (
              <DesktopLoading label={t("desktop.connecting")} overlay />
            )}
            <textarea
              class="desktop-keyboard-input"
              inputmode="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              tabindex={-1}
              aria-label={t("desktop.keyboardInput")}
              disabled={props.state !== "connected" || !props.controlling}
              value={props.keyboardInputValue}
              onKeyDown={props.onKeyboardEvent}
              onKeyUp={props.onKeyboardEvent}
              onInput={props.onKeyboardInput}
            />
            <nav class="desktop-touch-toolbar" aria-label={t("desktop.touchControls")}>
              {props.audioControl}
              {props.pictureInPictureControl}
              <button
                class="desktop-touch-action"
                type="button"
                aria-label={t(
                  props.controlling ? "desktop.switchToViewOnly" : "desktop.takeControl",
                )}
                aria-pressed={props.controlling ? "true" : "false"}
                disabled={props.state !== "connected"}
                onClick={props.onControlToggle}
              >
                <span class="desktop-touch-action__icon" aria-hidden="true">
                  <Icon name={props.controlling ? "hand" : "eye"} />
                </span>
                <span class="desktop-touch-action__label">
                  {t(props.controlling ? "desktop.control" : "desktop.viewOnly")}
                </span>
              </button>
              <button
                class="desktop-touch-action"
                type="button"
                aria-label={t("desktop.keyboard")}
                disabled={props.state !== "connected" || !props.controlling}
                onClick={props.onKeyboardFocus}
              >
                <span class="desktop-touch-action__icon" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect width="20" height="14" x="2" y="5" rx="2" />
                    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 17h8" />
                  </svg>
                </span>
                <span class="desktop-touch-action__label">{t("desktop.keyboard")}</span>
              </button>
              <DesktopSizing {...props.sizing} />
              <button
                class="desktop-touch-action"
                type="button"
                aria-label={t("desktop.back")}
                onClick={props.onClose}
              >
                <span class="desktop-touch-action__icon" aria-hidden="true">
                  <Icon name="arrowLeft" />
                </span>
                <span class="desktop-touch-action__label">{t("desktop.back")}</span>
              </button>
            </nav>
          </div>
        )}
      />
    </section>
  );
}
