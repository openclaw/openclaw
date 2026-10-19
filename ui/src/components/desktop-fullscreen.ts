import { createSignal, onSettled } from "solid-js";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { listen } from "../lib/reactive/listener.ts";

/** Fullscreen belongs to the mounted panel, independently of its desktop connection. */
export function createDesktopFullscreen(document: Document, onChange: () => void) {
  const [active, setActive] = createSignal(false);
  const [errorText, setErrorText] = createSignal<string | null>(null);
  let section: HTMLElement | undefined;
  let restoreFocus: HTMLButtonElement | undefined;
  const ownsFullscreen = () => Boolean(section && document.fullscreenElement === section);
  const supported = () =>
    document.fullscreenEnabled && typeof Element.prototype.requestFullscreen === "function";
  const failed = (error: unknown) =>
    setErrorText(t("desktop.errors.fullscreenFailed", { error: formatUiError(error) }));

  onSettled(() => {
    const changed = () => {
      const wasActive = active();
      const next = ownsFullscreen();
      setActive(next);
      onChange();
      if (wasActive && !next && restoreFocus) {
        const button = restoreFocus;
        restoreFocus = undefined;
        // The fullscreen bindings commit before restoring the initiating control.
        queueMicrotask(() => button.isConnected && button.focus());
      }
    };
    const stop = listen(document, "fullscreenchange", changed);
    return () => {
      stop();
      restoreFocus = undefined;
      if (ownsFullscreen()) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  });

  return {
    active,
    errorText,
    ownsFullscreen,
    supported,
    sectionRef: (element: HTMLElement) => {
      section = element;
    },
    async toggle(button: HTMLButtonElement) {
      setErrorText(null);
      if (ownsFullscreen()) {
        await document.exitFullscreen().catch(failed);
      } else if (!section || !supported()) {
        setErrorText(t("desktop.fullscreenUnavailable"));
      } else {
        restoreFocus = button;
        try {
          await section.requestFullscreen();
        } catch (error) {
          restoreFocus = undefined;
          failed(error);
        }
      }
    },
  };
}

export type DesktopFullscreen = ReturnType<typeof createDesktopFullscreen>;
