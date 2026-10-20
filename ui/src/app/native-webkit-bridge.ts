export type WebKitHostMessages = {
  openclawLink: { type: "open-link"; url: string; target: "external" };
  openclawUpdate: { type: "start-update" };
  openclawNav: { type: "nav-state"; collapsed: boolean; width: number };
  openclawWindowDrag: { type: "window-drag" };
  openclawGateways:
    | {
        type: "select" | "open-window" | "set-primary" | "reconnect" | "reconnect-cancel";
        id: string;
      }
    | { type: "open-settings" };
  openclawNotifications:
    | { type: "status" | "request-permission" | "send-test" }
    | {
        type: "background-session-completed";
        runId: string;
        path: string;
        search?: string;
      };
};

type WebKitMessageHandler<Message> = {
  postMessage(message: Message): void;
};

// Reply handlers resolve with the native outcome; keep values aligned with
// DefaultAppOpenOutcome in DashboardWindowController+Files.swift.
export type DefaultAppOpenOutcome = "opened" | "remote" | "missing" | "unsupported-type" | "no-app";
export type WebKitReplyHandlers = {
  openclawFiles: {
    postMessage(message: {
      type: "open-default-app";
      path: string;
    }): Promise<DefaultAppOpenOutcome>;
  };
};

type WebKitHostWindow = Window & {
  webkit?: {
    messageHandlers?: {
      [Name in keyof WebKitHostMessages]?: WebKitMessageHandler<WebKitHostMessages[Name]>;
    } & Partial<WebKitReplyHandlers>;
  };
};

export function webKitHostWindow(): WebKitHostWindow | undefined {
  // SAFETY: WebKit owns this optional ambient bridge and the mapped contract narrows every handler.
  return typeof window === "undefined" ? undefined : (window as WebKitHostWindow);
}
