import { resolveGatewayWebSocketUrl } from "../../lib/gateway-websocket-url.ts";
import { isApplePlatform } from "../../lib/keyboard-shortcut-contract.ts";

export type DesktopDisconnectDetail = {
  clean: boolean;
  code?: number;
  reason?: string;
};

type DesktopSecurityFailureDetail = {
  reason?: string;
  status?: number;
};

export type DesktopSizingMode = "fit" | "actual" | "match";

type DesktopConnectOptions = {
  background?: string;
  credentials?: { username?: string; password?: string };
  gatewayUrl?: string;
  isCurrent: () => boolean;
  onConnect?: () => void;
  onDisconnect?: (detail: DesktopDisconnectDetail) => void;
  onSecurityFailure?: (detail: DesktopSecurityFailureDetail) => void;
  canResize?: boolean;
  sizingMode?: DesktopSizingMode;
  target: HTMLElement;
  viewOnly: boolean;
  wsUrl: string;
};

export type DesktopConnectionHandle = {
  disconnect(): void;
  disableInput(): void;
  setPresented(presented: boolean): boolean;
  sendBackspace(): void;
  sendKeyboardEvent(event: KeyboardEvent): void;
  sendText(text: string): void;
  setSizingMode(mode: DesktopSizingMode): void;
};

type RfbClient = EventTarget & {
  background: string;
  disconnect(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  scaleViewport: boolean;
  resizeSession: boolean;
  viewOnly: boolean;
};

type RfbConstructor = new (
  target: HTMLElement,
  channel: string | WebSocket,
  options?: { credentials?: { username?: string; password?: string } },
) => RfbClient;

type RfbLoader = () => Promise<RfbConstructor>;
type WebSocketFactory = (url: string) => WebSocket;

const loadDefaultRfb: RfbLoader = async () => {
  // @novnc/novnc 1.7 exports RFB from the package root; keeping this import
  // here ensures the substantial client stays in the lazy desktop chunk.
  const module = (await import("@novnc/novnc")) as { default: RfbConstructor };
  return module.default;
};

/** Thin owner for one noVNC RFB lifecycle. */
export class DesktopClient {
  constructor(
    private readonly rfbConstructor?: RfbConstructor,
    private readonly createWebSocket: WebSocketFactory = (url) => new WebSocket(url),
    private readonly loadRfb: RfbLoader = loadDefaultRfb,
  ) {}

  async connect(options: DesktopConnectOptions): Promise<DesktopConnectionHandle> {
    const Rfb = this.rfbConstructor ?? (await this.loadRfb());
    const wsUrl = resolveGatewayWebSocketUrl(options.wsUrl, options.gatewayUrl);
    // The socket claims control before RFB authentication; canceled lazy loads must not open it.
    if (!options.isCurrent()) {
      throw new DOMException("Desktop connection is no longer current", "AbortError");
    }
    const socket = this.createWebSocket(wsUrl);
    let closeDetail: Pick<CloseEvent, "code" | "reason"> | undefined;
    socket.addEventListener("close", (event) => {
      closeDetail = { code: event.code, reason: event.reason };
    });
    const rfb = new Rfb(
      options.target,
      socket,
      options.credentials ? { credentials: options.credentials } : undefined,
    );
    rfb.background = options.background ?? getComputedStyle(options.target).backgroundColor;
    rfb.viewOnly = options.viewOnly;
    rfb.resizeSession = false;
    let retired = false;
    let inputDisabled = false;
    let presented = true;
    let connected = false;
    let sizingMode = options.sizingMode ?? "fit";
    const dispatchKeyboardEvent = (event: KeyboardEvent) => {
      // noVNC owns translation for both canvas input and the mobile keyboard bridge.
      options.target.querySelector("canvas")?.dispatchEvent(event);
    };
    const cloneKeyboardEvent = (event: KeyboardEvent, type = event.type) =>
      new KeyboardEvent(type, {
        key: event.key,
        code: event.code,
        location: event.location,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        bubbles: true,
        cancelable: true,
      });
    const heldKeys = new Map<string, KeyboardEvent>();
    const activePointers = new Set<number>();
    const trackKeyDown = (event: KeyboardEvent) => {
      const code = event.code || event.key;
      // noVNC completes virtual presses and macOS CapsLock toggles on keydown.
      if (
        !rfb.viewOnly &&
        !retired &&
        code !== "Unidentified" &&
        !(code === "CapsLock" && isApplePlatform())
      ) {
        heldKeys.set(code, event);
      }
    };
    const trackKeyUp = (event: KeyboardEvent) => heldKeys.delete(event.code || event.key);
    const clearHeldKeys = () => heldKeys.clear();
    const releaseHeldKeys = () => {
      // noVNC's viewOnly setter suppresses ungrab's keyups. Send them through
      // its keyboard owner before setting viewOnly, while the socket can still write.
      for (const event of heldKeys.values()) {
        dispatchKeyboardEvent(cloneKeyboardEvent(event, "keyup"));
      }
      heldKeys.clear();
    };
    const trackPointerDown = (event: PointerEvent) => activePointers.add(event.pointerId);
    const trackPointerUp = (event: PointerEvent) => activePointers.delete(event.pointerId);
    options.target.addEventListener("keydown", trackKeyDown, true);
    options.target.addEventListener("keyup", trackKeyUp, true);
    options.target.addEventListener("pointerdown", trackPointerDown, true);
    window.addEventListener("pointerup", trackPointerUp, true);
    window.addEventListener("pointercancel", trackPointerUp, true);
    window.addEventListener("blur", clearHeldKeys);
    const stopInputTracking = () => {
      options.target.removeEventListener("keydown", trackKeyDown, true);
      options.target.removeEventListener("keyup", trackKeyUp, true);
      options.target.removeEventListener("pointerdown", trackPointerDown, true);
      window.removeEventListener("pointerup", trackPointerUp, true);
      window.removeEventListener("pointercancel", trackPointerUp, true);
      window.removeEventListener("blur", clearHeldKeys);
      heldKeys.clear();
      activePointers.clear();
    };
    const disableInput = () => {
      releaseHeldKeys();
      inputDisabled = true;
      rfb.resizeSession = false;
      rfb.viewOnly = true;
    };
    const applySizing = () => {
      // Provider permission is not negotiated RFB support. noVNC owns negotiation
      // and resize scheduling, but only the current authenticated controller may opt in.
      rfb.resizeSession = false;
      if (retired || !options.isCurrent()) {
        return;
      }
      rfb.scaleViewport = sizingMode !== "actual";
      rfb.resizeSession =
        presented &&
        connected &&
        !rfb.viewOnly &&
        options.canResize === true &&
        sizingMode === "match";
    };
    applySizing();
    rfb.addEventListener("connect", () => {
      if (retired || !options.isCurrent()) {
        disableInput();
        return;
      }
      connected = true;
      options.onConnect?.();
      applySizing();
    });
    rfb.addEventListener("disconnect", (event) => {
      // noVNC's terminal state is permanent; callbacks may synchronously retire this handle.
      retired = true;
      disableInput();
      stopInputTracking();
      // SAFETY: noVNC's public disconnect event carries clean, even before the socket closes.
      const { clean } = (event as CustomEvent<{ clean: boolean }>).detail;
      options.onDisconnect?.({ ...closeDetail, clean });
    });
    rfb.addEventListener("securityfailure", (event) => {
      disableInput();
      const detail = (event as CustomEvent<DesktopSecurityFailureDetail>).detail ?? {};
      options.onSecurityFailure?.(detail);
    });
    return {
      disconnect: () => {
        if (!retired) {
          retired = true;
          disableInput();
          stopInputTracking();
          rfb.disconnect();
        }
      },
      disableInput,
      setPresented: (value) => {
        presented = value;
        if (retired || inputDisabled || !options.isCurrent()) {
          return false;
        }
        // noVNC cannot release a drag through its public API after the canvas is
        // hidden. Retire that connection instead of retaining pressed remote buttons.
        if (!presented && activePointers.size > 0) {
          return false;
        }
        if (!presented) {
          releaseHeldKeys();
        }
        rfb.resizeSession = false;
        rfb.viewOnly = !presented || options.viewOnly;
        applySizing();
        return true;
      },
      setSizingMode: (mode) => {
        sizingMode = mode;
        applySizing();
      },
      sendKeyboardEvent: (event) => dispatchKeyboardEvent(cloneKeyboardEvent(event)),
      sendText: (text) => {
        // Mobile IMEs can omit keydown/keyup. "Unidentified" asks noVNC's
        // keyboard owner to translate each inserted character and emit a
        // balanced press/release. Line breaks need Enter rather than Unicode LF.
        const normalizedText = text.replace(/\r\n?/g, "\n");
        for (const character of normalizedText) {
          // noVNC 1.7's DOM key translator only accepts BMP characters. Its
          // public RFB sender supports the full Unicode scalar keysym directly.
          if (character.length === 2) {
            rfb.sendKey(0x01000000 | character.codePointAt(0)!, null);
            continue;
          }
          dispatchKeyboardEvent(
            new KeyboardEvent("keydown", {
              key: character === "\n" ? "Enter" : character,
              code: "Unidentified",
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      },
      sendBackspace: () => rfb.sendKey(0xff08, "Backspace"),
    };
  }
}
