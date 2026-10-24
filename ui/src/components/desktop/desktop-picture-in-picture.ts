import { action, createOptimistic, createSignal, onSettled } from "solid-js";
import { t } from "../../i18n/index.ts";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import { listen } from "../../lib/reactive/listener.ts";

registerDesktopEnglish();

// Document PiP is not yet in our TypeScript DOM library. Detect the API, not the UA.
type PictureInPictureWindow = Window & {
  documentPictureInPicture?: {
    requestWindow(options: { width: number; height: number }): Promise<Window>;
  };
};

/** View-only pixels from the existing RFB connection; never owns a socket or input. */
export function createDesktopPictureInPicture(
  host: Pick<HTMLElement, "ownerDocument" | "isConnected">,
  readSource: () => HTMLCanvasElement | null,
) {
  const [active, setActive] = createSignal(false);
  const [outcome, setOutcome] = createSignal<{ result: Promise<void> }>();
  const [opening, setOpening] = createOptimistic(false);
  let activePopup: Window | null = null;
  let pending: { cancelled: boolean } | undefined;
  let stopMirror: (() => void) | null = null;
  const opener = (): PictureInPictureWindow | null => host.ownerDocument.defaultView;
  const supported = () =>
    opener()?.isSecureContext === true &&
    typeof opener()?.documentPictureInPicture?.requestWindow === "function";
  const release = () => {
    stopMirror?.();
    stopMirror = null;
    const popup = activePopup;
    activePopup = null;
    popup?.close();
  };
  onSettled(() => () => {
    pending = undefined;
    release();
  });
  const close = () => {
    // A cancelled native request stays busy until the browser settles it.
    if (pending) {
      pending.cancelled = true;
    }
    release();
    setActive(false);
    setOutcome(undefined);
  };
  const toggle = action(function* (): Generator<Promise<Window>, void, Window> {
    if (activePopup) {
      close();
      return;
    }
    const window = opener();
    const api = window?.documentPictureInPicture;
    const source = readSource();
    if (pending || !window?.isSecureContext || !api || !source || !host.isConnected) {
      return;
    }
    const request = { cancelled: false };
    pending = request;
    setOpening(true);
    let popup: Window | null = null;
    try {
      // Must happen directly in the click's user activation, before yielding.
      popup = yield api.requestWindow({ width: 640, height: 400 });
      if (
        popup.closed ||
        pending !== request ||
        request.cancelled ||
        !host.isConnected ||
        readSource() !== source
      ) {
        popup.close();
        return;
      }
      activePopup = popup;
      startMirror(popup, source);
    } catch {
      popup?.close();
      if (pending === request && !request.cancelled) {
        release();
        throw new Error(t("desktop.errors.pictureInPictureFailed"));
      }
    } finally {
      if (pending === request) {
        pending = undefined;
        setActive(activePopup !== null);
      }
    }
  });

  const startMirror = (popup: Window, source: HTMLCanvasElement) => {
    const doc = popup.document;
    doc.title = t("desktop.pictureInPictureTitle");
    doc.documentElement.lang = host.ownerDocument.documentElement.lang;
    const canvas = doc.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", t("desktop.pictureInPictureTitle"));
    // No input listeners or focusable remote surface. The original canvas stays mounted.
    canvas.style.cssText =
      "display:block;width:100%;height:100%;object-fit:contain;pointer-events:none";
    doc.body.style.cssText =
      "margin:0;height:100vh;background:var(--bg);color:var(--text);overflow:hidden";
    doc.body.replaceChildren(canvas);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Picture-in-Picture canvas is unavailable");
    }
    const openerRoot = host.ownerDocument.documentElement;
    const syncTheme = () => {
      const style = getComputedStyle(openerRoot);
      doc.documentElement.style.setProperty("--bg", style.getPropertyValue("--bg"));
      doc.documentElement.style.setProperty("--text", style.getPropertyValue("--text"));
      doc.documentElement.style.colorScheme = style.colorScheme;
    };
    syncTheme();
    // Theme preferences can publish before a lazy palette loads. Observe the theme
    // owner's applied presentation, including same-mode custom palette replacements.
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(openerRoot, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-mode", "style"],
    });
    let frame = 0;
    let lastPaint = -Infinity;
    const onClose = () => {
      if (activePopup === popup) {
        close();
      }
    };
    const stopClose = listen(popup, "pagehide", onClose, { once: true });
    stopMirror = () => {
      themeObserver.disconnect();
      popup.cancelAnimationFrame(frame);
      stopClose();
      canvas.remove();
    };
    const paint = (now: number) => {
      if (activePopup !== popup) {
        return;
      }
      if (popup.closed || readSource() !== source || !source.isConnected) {
        close();
        return;
      }
      try {
        // noVNC 1.7 flips incoming frames synchronously. Use the visible PiP window's
        // clock, NOT the opener's rAF (suspended in background tabs). Bound copy work
        // to 30fps and the displayed resolution; no encoding, stream, or second RFB.
        if (now - lastPaint >= 1000 / 30 && source.width > 0 && source.height > 0) {
          const scale = Math.min(
            1,
            (popup.innerWidth * popup.devicePixelRatio) / source.width,
            (popup.innerHeight * popup.devicePixelRatio) / source.height,
          );
          const width = Math.max(1, Math.round(source.width * scale));
          const height = Math.max(1, Math.round(source.height * scale));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          context.drawImage(source, 0, 0, width, height);
          lastPaint = now;
        }
        frame = popup.requestAnimationFrame(paint);
      } catch {
        // Never leave a frozen image presented as a connected viewer.
        close();
        const result = Promise.reject(new Error(t("desktop.errors.pictureInPictureFailed")));
        setOutcome({ result });
        void result.catch(() => {});
      }
    };
    frame = popup.requestAnimationFrame(paint);
  };

  return {
    feedback: () => (opening() ? { pending: true } : { active: active() }),
    outcome,
    supported,
    close,
    toggle() {
      // A duplicate click must keep observing the admitted native request.
      if (pending) {
        return undefined;
      }
      const result = toggle();
      setOutcome({ result });
      void result.catch(() => {});
      return result;
    },
  };
}

export type DesktopPictureInPicture = ReturnType<typeof createDesktopPictureInPicture>;
