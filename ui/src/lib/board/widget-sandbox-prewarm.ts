import { observeWindowMessage } from "../reactive/window-message.ts";
import { WidgetSandboxHost } from "../widget-sandbox-host.ts";

export type PreparedBoardSandbox = ReturnType<typeof prepareBoardSandbox>;

export function createBoardSandboxFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "board-widget__frame";
  frame.allow = "fullscreen";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  frame.referrerPolicy = "origin";
  frame.setAttribute("loading", "eager");
  return frame;
}

/** Retain the exact proxy and its real readiness until the lazy view adopts it. */
export function prepareBoardSandbox(url: string) {
  const parking = document.createElement("div");
  parking.inert = true;
  parking.setAttribute("aria-hidden", "true");
  // An offscreen cross-origin proxy would postpone layout until after adoption.
  parking.style.cssText =
    "position:fixed;left:0;top:0;width:600px;height:600px;opacity:0;pointer-events:none;z-index:-1";
  const frame = createBoardSandboxFrame();
  frame.src = url;
  parking.append(frame);
  document.body.append(parking);
  const host = new WidgetSandboxHost({
    frame,
    sandboxOrigin: new URL(url).origin,
    sandboxUrl: url,
  });
  const stop = observeWindowMessage(window, frame.contentWindow!, (event) =>
    host.handleMessage(event),
  );
  let adopted = false;
  return {
    frame,
    host,
    adopt(container: HTMLElement): void {
      container.moveBefore(frame, null);
      adopted = true;
      stop();
      parking.remove();
    },
    dispose(): void {
      stop();
      if (!adopted) {
        host.dispose();
        parking.remove();
      }
    },
  };
}
