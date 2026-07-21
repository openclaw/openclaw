import type { GatewayBrowserClient } from "../../api/gateway.ts";

type PluginUiBridgeTarget = {
  frame: HTMLIFrameElement;
  key: string;
  pluginId: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  contextTokens?: number;
  sessionActions: readonly string[];
  allowChatNavigation: boolean;
  navigateToChat: (sessionKey: string) => void;
};

type PluginUiBridgeMessage = {
  v?: unknown;
  type?: unknown;
  id?: unknown;
  actionId?: unknown;
  payload?: unknown;
  target?: unknown;
  sessionKey?: unknown;
};

function normalizeMessageId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin UI action failed";
}

/**
 * Gives one opaque plugin tab a narrow parent capability channel.
 *
 * The child can invoke only session actions named by its own tab descriptor.
 * The authenticated Gateway connection still enforces each action's registered
 * operator scopes. The child never receives a bearer token or generic fetch
 * proxy, and the parent supplies the active target session instead of accepting
 * one from the frame.
 */
export class PluginUiBridgeController {
  private target: PluginUiBridgeTarget | null = null;
  private port: MessagePort | null = null;
  private loadHandler: (() => void) | null = null;
  private readyHandler: ((event: MessageEvent) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private observedInitialLoad = false;

  sync(target: PluginUiBridgeTarget | null) {
    if (!target) {
      this.clear();
      return;
    }
    const currentTarget = this.target;
    if (currentTarget?.frame === target.frame) {
      // Keep object identity stable for the active port listener while
      // refreshing callback/client references from the latest UI context.
      // UI snapshots can also refine session context after the first action
      // starts; replacing the transferred port would orphan that request.
      // Handlers read this mutable target, so the established port immediately
      // uses the latest connection, scopes, session, and context window.
      Object.assign(currentTarget, target);
      return;
    }

    this.clear();
    this.target = target;
    this.loadHandler = () => {
      if (!this.observedInitialLoad) {
        this.observedInitialLoad = true;
        // A child can announce readiness before its initial iframe load event
        // reaches the parent. Keep the port established by that ready message;
        // only later loads represent a replacement document.
        if (!this.port) {
          this.scheduleConnect();
        }
        return;
      }
      // A load means the frame has a new document and can no longer use the
      // previously transferred port. Invalidate it before reconnecting.
      this.port?.close();
      this.port = null;
      this.scheduleConnect();
    };
    target.frame.addEventListener("load", this.loadHandler);
    this.readyHandler = (event: MessageEvent) => {
      const data = event.data as { v?: unknown; type?: unknown } | null;
      if (
        this.target?.frame === target.frame &&
        event.source === target.frame.contentWindow &&
        data?.v === 1 &&
        data.type === "openclaw.pluginUi.ready"
      ) {
        // Plugins may repeat `ready` until the first connection arrives. A
        // queued repeat can land just after the port transfer; do not replace
        // that healthy port merely because the readiness retry was in flight.
        if (!this.port) {
          this.scheduleConnect();
        }
      }
    };
    window.addEventListener("message", this.readyHandler);
  }

  private scheduleConnect() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    // A sandboxed frame commonly emits its ready message immediately before
    // the iframe load event. Coalesce both triggers so an action sent on the
    // first transferred port cannot be orphaned by an immediate replacement.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, 20);
  }

  private connect() {
    const target = this.target;
    const frameWindow = target?.frame.contentWindow;
    if (!target || !frameWindow) {
      return;
    }
    this.port?.close();
    const channel = new MessageChannel();
    const port = channel.port1;
    this.port = port;
    port.addEventListener("message", (event: MessageEvent) => {
      if (this.target !== target || this.port !== port) {
        return;
      }
      const message = event.data as PluginUiBridgeMessage | null;
      if (message?.v !== 1) {
        return;
      }
      if (message.type === "openclaw.pluginUi.sessionAction") {
        void this.handleSessionAction(target, port, message);
        return;
      }
      if (message.type === "openclaw.pluginUi.navigate") {
        this.handleNavigation(target, port, message);
      }
    });
    port.start();
    // Sandboxed plugin frames have an opaque origin, so source-window and
    // transferred-port identity are the capability boundary rather than origin.
    frameWindow.postMessage(
      {
        v: 1,
        type: "openclaw.pluginUi.connect",
        capabilities: {
          sessionActions: [...target.sessionActions],
          navigateToChat: target.allowChatNavigation,
        },
        context: {
          sessionKey: target.sessionKey,
          ...(target.contextTokens !== undefined ? { contextTokens: target.contextTokens } : {}),
        },
      },
      "*",
      [channel.port2],
    );
  }

  private reply(
    target: PluginUiBridgeTarget,
    port: MessagePort,
    id: string,
    payload: Record<string, unknown>,
  ) {
    if (!id || this.target !== target || this.port !== port) {
      return;
    }
    // MessagePort has no targetOrigin.
    port.postMessage({ v: 1, type: "openclaw.pluginUi.response", id, ...payload });
  }

  private async handleSessionAction(
    target: PluginUiBridgeTarget,
    port: MessagePort,
    message: PluginUiBridgeMessage,
  ) {
    const id = normalizeMessageId(message.id);
    const actionId = typeof message.actionId === "string" ? message.actionId.trim() : "";
    if (!id || !actionId || !target.sessionActions.includes(actionId)) {
      this.reply(target, port, id, { ok: false, error: "Plugin UI action is not allowed" });
      return;
    }
    if (!target.connected || !target.client) {
      this.reply(target, port, id, { ok: false, error: "Gateway is disconnected" });
      return;
    }
    try {
      const result = await target.client.request("plugins.sessionAction", {
        pluginId: target.pluginId,
        actionId,
        sessionKey: target.sessionKey,
        ...(target.contextTokens !== undefined ? { contextTokens: target.contextTokens } : {}),
        ...(message.payload !== undefined ? { payload: message.payload } : {}),
      });
      this.reply(target, port, id, { ok: true, result });
    } catch (error) {
      this.reply(target, port, id, { ok: false, error: errorMessage(error) });
    }
  }

  private handleNavigation(
    target: PluginUiBridgeTarget,
    port: MessagePort,
    message: PluginUiBridgeMessage,
  ) {
    const id = normalizeMessageId(message.id);
    const requestedSessionKey =
      typeof message.sessionKey === "string" ? message.sessionKey.trim() : "";
    if (!target.allowChatNavigation || message.target !== "chat") {
      this.reply(target, port, id, { ok: false, error: "Plugin UI navigation is not allowed" });
      return;
    }
    target.navigateToChat(requestedSessionKey || target.sessionKey);
    this.reply(target, port, id, { ok: true });
  }

  clear() {
    if (this.target && this.loadHandler) {
      this.target.frame.removeEventListener("load", this.loadHandler);
    }
    if (this.readyHandler) {
      window.removeEventListener("message", this.readyHandler);
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    this.port?.close();
    this.target = null;
    this.port = null;
    this.loadHandler = null;
    this.readyHandler = null;
    this.connectTimer = null;
    this.observedInitialLoad = false;
  }
}
