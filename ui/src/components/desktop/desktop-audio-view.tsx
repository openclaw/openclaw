import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import "../tooltip.ts";

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
registerEnglishCatalog(registerDesktopEnglish);

export function DesktopAudioControl(props: {
  state: DesktopAudioState;
  connected: boolean;
  documentMode: boolean;
  onToggle: () => void;
}) {
  const active = () => props.state === "playing" || props.state === "starting";
  const unavailable = () =>
    ["unavailable", "setup-unavailable", "unsupported", "error"].includes(props.state);
  const setupUnavailable = () => props.state === "setup-unavailable";
  const disabled = () => !props.connected || unavailable() || props.state === "connecting";
  const label = () =>
    t(
      props.state === "retired"
        ? "desktop.audio.reconnect"
        : props.state === "unavailable" || setupUnavailable()
          ? "desktop.audio.unavailable"
          : props.state === "unsupported"
            ? "desktop.audio.unsupported"
            : props.state === "error"
              ? "desktop.audio.failed"
              : props.state === "connecting"
                ? "desktop.audio.connecting"
                : active()
                  ? "desktop.audio.mute"
                  : "desktop.audio.unmute",
    );
  const control = () => (
    <button
      class={[
        props.documentMode ? "desktop-touch-action" : "desktop-toolbar-action",
        "desktop-audio-button",
      ]}
      type="button"
      title={setupUnavailable() ? undefined : label()}
      aria-label={label()}
      aria-pressed={active() ? "true" : "false"}
      aria-busy={props.state === "starting" || props.state === "connecting" ? "true" : "false"}
      aria-disabled={setupUnavailable() ? "true" : undefined}
      disabled={disabled() && !setupUnavailable()}
      onClick={() => {
        if (!disabled()) {
          props.onToggle();
        }
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polygon points="11 5 6 9 3 9 3 15 6 15 11 19 11 5" />
        {active() ? (
          <path d="M15.5 8.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13" />
        ) : (
          <path d="m17 9 6 6m0-6-6 6" />
        )}
      </svg>
      <span class="desktop-audio-label">
        {t(
          props.state === "retired"
            ? "desktop.audio.reconnect"
            : unavailable()
              ? "desktop.audio.unavailable"
              : active()
                ? "desktop.audio.mute"
                : "desktop.audio.unmute",
        )}
      </span>
    </button>
  );
  return (
    <>
      {setupUnavailable() ? (
        <openclaw-tooltip open-on-click prop:content={t("desktop.audio.setupUnavailable")}>
          {control()}
        </openclaw-tooltip>
      ) : (
        control()
      )}
    </>
  );
}

export function DesktopAudioNotice(props: { state: DesktopAudioState }) {
  const message = () =>
    props.state === "blocked"
      ? t("desktop.audio.blocked")
      : props.state === "unsupported"
        ? t("desktop.audio.unsupported")
        : props.state === "error"
          ? t("desktop.audio.failed")
          : null;
  return (
    <>
      {message() && (
        <div class="desktop-note desktop-note--error" role="alert">
          {message()}
        </div>
      )}
    </>
  );
}
