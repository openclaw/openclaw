import { html, nothing, svg } from "lit";
import { t } from "../../i18n/index.ts";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import { strokeIcon } from "../icons-tools.ts";

export type DesktopAudioState =
  | "unavailable"
  | "setup-unavailable"
  | "retired"
  | "connecting"
  | "muted"
  | "starting"
  | "playing"
  | "blocked"
  | "unsupported"
  | "error";

registerDesktopEnglish();

const speaker = svg`<polygon points="11 5 6 9 3 9 3 15 6 15 11 19 11 5" />`;
const mutedIcon = strokeIcon(svg`${speaker}<path d="m17 9 6 6m0-6-6 6" />`);
const playingIcon = strokeIcon(
  svg`${speaker}<path d="M15.5 8.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13" />`,
);

export function renderDesktopAudioControl(options: {
  state: DesktopAudioState;
  connected: boolean;
  documentMode: boolean;
  onToggle: () => void;
}) {
  const active = options.state === "playing" || options.state === "starting";
  const unavailable =
    options.state === "unavailable" ||
    options.state === "setup-unavailable" ||
    options.state === "unsupported" ||
    options.state === "error";
  const label = t(
    options.state === "retired"
      ? "desktop.audio.reconnect"
      : options.state === "unavailable" || options.state === "setup-unavailable"
        ? "desktop.audio.unavailable"
        : options.state === "unsupported"
          ? "desktop.audio.unsupported"
          : options.state === "error"
            ? "desktop.audio.failed"
            : options.state === "connecting"
              ? "desktop.audio.connecting"
              : active
                ? "desktop.audio.mute"
                : "desktop.audio.unmute",
  );
  return html`<button
    class=${(options.documentMode ? "desktop-touch-action" : "desktop-toolbar-action") + " desktop-audio-button"}
    type="button"
    title=${label}
    aria-label=${label}
    aria-pressed=${active ? "true" : "false"}
    aria-busy=${options.state === "starting" || options.state === "connecting" ? "true" : "false"}
    ?disabled=${!options.connected || unavailable || options.state === "connecting"}
    @click=${options.onToggle}
  >
    ${active ? playingIcon : mutedIcon}
    <span class="desktop-audio-label"
      >${t(options.state === "retired" ? "desktop.audio.reconnect" : unavailable ? "desktop.audio.unavailable" : active ? "desktop.audio.mute" : "desktop.audio.unmute")}</span
    >
  </button>`;
}

export function renderDesktopAudioNotice(state: DesktopAudioState) {
  const message =
    state === "setup-unavailable"
      ? t("desktop.audio.setupUnavailable")
      : state === "blocked"
        ? t("desktop.audio.blocked")
        : state === "unsupported"
          ? t("desktop.audio.unsupported")
          : state === "error"
            ? t("desktop.audio.failed")
            : null;
  return message
    ? html`<div class="desktop-note desktop-note--error" role="alert">${message}</div>`
    : nothing;
}
