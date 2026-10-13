import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

type PluginUiBridgeTarget = {
  frame: HTMLIFrameElement;
  key: string;
  nonce: string;
  pluginId: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  contextTokens?: number;
  sessionActions: readonly string[];
};

type PluginUiBridgeMessage = {
  v?: unknown;
  type?: unknown;
  id?: unknown;
  actionId?: unknown;
  payload?: unknown;
  contextRevision?: unknown;
  nonce?: unknown;
};

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeMessageId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin UI action failed";
}

function parsePluginUiBridgeMessage(value: unknown): PluginUiBridgeMessage | null {
  return isRecord(value) ? value : null;
}

// MessagePort accepts structured-clone values that JSON would silently coerce
// or discard. Reject those before the Gateway client's JSON serialization.
function isJsonPayload(value: unknown, state = { nodes: 0 }, depth = 0): boolean {
  state.nodes += 1;
  if (state.nodes > 4096 || depth > 32) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    // Iteration visits holes as undefined, unlike Array.prototype.every.
    for (const entry of value) {
      if (!isJsonPayload(entry, state, depth + 1)) {
        return false;
      }
    }
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== null &&
    (Object.getPrototypeOf(prototype) !== null ||
      Object.prototype.toString.call(value) !== "[object Object]")
  ) {
    return false;
  }
  return Object.values(value).every((entry) => isJsonPayload(entry, state, depth + 1));
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
  private documentPort: MessagePort | null = null;
  private documentVerificationId = 0;
  private pendingDocumentVerification: { id: number; onVerified: () => void } | null = null;
  private loadHandler: (() => void) | null = null;
  private readyHandler: ((event: MessageEvent) => void) | null = null;
  private loadState: "initial" | "active" | "replacement" | "revoked" = "initial";
  private contextRevision = 0;

  sync(target: PluginUiBridgeTarget | null) {
    if (!target) {
      this.clear();
      return;
    }
    const currentTarget = this.target;
    if (
      currentTarget?.frame === target.frame &&
      currentTarget.key === target.key &&
      currentTarget.nonce === target.nonce
    ) {
      const sessionChanged = currentTarget.sessionKey !== target.sessionKey;
      const contextChanged = sessionChanged || currentTarget.contextTokens !== target.contextTokens;
      const capabilitiesChanged = !sameStrings(currentTarget.sessionActions, target.sessionActions);
      // Keep object identity stable for the active port listener while
      // refreshing callback/client references from the latest UI context.
      // UI snapshots can also refine session context after the first action
      // starts; replacing the transferred port would orphan that request.
      // Handlers read this mutable target, so the established port immediately
      // uses the latest connection, scopes, session, and context window.
      Object.assign(currentTarget, target);
      if (this.port && (contextChanged || capabilitiesChanged)) {
        if (contextChanged) {
          this.contextRevision += 1;
        }
        this.postConnectionState(currentTarget, this.port, "openclaw.pluginUi.update");
      }
      return;
    }

    const reusesFrameForAnotherTab = currentTarget?.frame === target.frame;
    this.clear();
    this.target = target;
    this.loadState = reusesFrameForAnotherTab ? "replacement" : "initial";
    this.loadHandler = () => {
      if (this.loadState === "replacement") {
        // The renderer can reuse the iframe element across plugin routes. Do not let the
        // retiring document reacquire a port carrying the next tab's grant.
        this.loadState = "active";
        return;
      }
      if (this.loadState === "initial") {
        this.loadState = "active";
        return;
      }
      if (this.loadState === "revoked") {
        return;
      }
      // A later same-tab load is an uncontrolled document replacement. The
      // WindowProxy survives navigation and opaque sandbox origins cannot
      // identify the new document, so revoke this frame until the parent
      // intentionally selects a new tab key.
      this.port?.close();
      this.port = null;
      this.documentPort?.close();
      this.documentPort = null;
      this.pendingDocumentVerification = null;
      this.loadState = "revoked";
    };
    target.frame.addEventListener("load", this.loadHandler);
    this.readyHandler = (event: MessageEvent) => {
      const data = parsePluginUiBridgeMessage(event.data);
      if (data?.v !== 1 || data.type !== "openclaw.pluginUi.ready") {
        return;
      }
      const offeredPort = event.ports[0];
      const offeredDocumentPort = event.ports[1];
      if (
        this.loadState === "replacement" ||
        this.loadState === "revoked" ||
        this.target?.frame !== target.frame ||
        event.source !== target.frame.contentWindow ||
        data.nonce !== target.nonce ||
        event.ports.length !== 2 ||
        !offeredPort ||
        !offeredDocumentPort ||
        this.port
      ) {
        for (const port of event.ports) {
          port.close();
        }
        return;
      }
      this.connect(target, offeredPort, offeredDocumentPort);
    };
    window.addEventListener("message", this.readyHandler);
  }

  verifyDocument(onVerified: () => void): boolean {
    const port = this.documentPort;
    if (!this.target || !port || this.loadState === "replacement" || this.loadState === "revoked") {
      return false;
    }
    const id = ++this.documentVerificationId;
    // Only the newest navigation intent needs proof. A WindowProxy survives
    // navigation, but this private endpoint stays with the injected document.
    this.pendingDocumentVerification = { id, onVerified };
    port.postMessage({ v: 1, type: "openclaw.pluginUi.verifyDocument", id });
    return true;
  }

  private connect(target: PluginUiBridgeTarget, port: MessagePort, documentPort: MessagePort) {
    this.port?.close();
    this.port = port;
    this.documentPort?.close();
    this.documentPort = documentPort;
    this.pendingDocumentVerification = null;
    port.addEventListener("message", (event: MessageEvent) => {
      if (this.target !== target || this.port !== port) {
        return;
      }
      const message = parsePluginUiBridgeMessage(event.data);
      if (message?.v !== 1) {
        return;
      }
      if (message.type === "openclaw.pluginUi.sessionAction") {
        void this.handleSessionAction(target, port, message);
      }
    });
    port.start();
    documentPort.addEventListener("message", (event: MessageEvent) => {
      const message = parsePluginUiBridgeMessage(event.data);
      const pending = this.pendingDocumentVerification;
      if (
        this.target !== target ||
        this.documentPort !== documentPort ||
        !pending ||
        message?.v !== 1 ||
        message.type !== "openclaw.pluginUi.documentVerified" ||
        message.id !== pending.id
      ) {
        return;
      }
      this.pendingDocumentVerification = null;
      // The caller rechecks current frame ownership and authorization before
      // applying the request. This proof certifies only the injected document.
      pending.onVerified();
    });
    documentPort.start();
    this.contextRevision += 1;
    // The registered document offers this nonce-bound private port. Sending
    // capabilities on it binds them to that document even if its WindowProxy
    // navigates before the parent receives the offer.
    this.postConnectionState(target, port, "openclaw.pluginUi.connect");
  }

  private postConnectionState(
    target: PluginUiBridgeTarget,
    port: MessagePort,
    type: "openclaw.pluginUi.connect" | "openclaw.pluginUi.update",
  ) {
    port.postMessage({
      v: 1,
      type,
      capabilities: {
        sessionActions: [...target.sessionActions],
      },
      context: {
        sessionKey: target.sessionKey,
        revision: this.contextRevision,
        ...(target.contextTokens !== undefined ? { contextTokens: target.contextTokens } : {}),
      },
    });
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
    if (message.contextRevision !== this.contextRevision) {
      this.reply(target, port, id, {
        ok: false,
        error: "Plugin UI session context is stale",
        contextRevision: message.contextRevision,
      });
      return;
    }
    if (!target.connected || !target.client) {
      this.reply(target, port, id, { ok: false, error: "Gateway is disconnected" });
      return;
    }
    if (message.payload !== undefined && !isJsonPayload(message.payload)) {
      this.reply(target, port, id, {
        ok: false,
        error: "Plugin UI action payload must be JSON-compatible",
        contextRevision: message.contextRevision,
      });
      return;
    }
    try {
      const result = await target.client.request("plugins.sessionAction", {
        pluginId: target.pluginId,
        actionId,
        sessionKey: target.sessionKey,
        ...(message.payload !== undefined ? { payload: message.payload } : {}),
      });
      this.reply(target, port, id, {
        ok: true,
        result,
        contextRevision: message.contextRevision,
      });
    } catch (error) {
      this.reply(target, port, id, {
        ok: false,
        error: errorMessage(error),
        contextRevision: message.contextRevision,
      });
    }
  }

  clear() {
    if (this.target && this.loadHandler) {
      this.target.frame.removeEventListener("load", this.loadHandler);
    }
    if (this.readyHandler) {
      window.removeEventListener("message", this.readyHandler);
    }
    this.port?.close();
    this.documentPort?.close();
    this.target = null;
    this.port = null;
    this.documentPort = null;
    this.pendingDocumentVerification = null;
    this.loadHandler = null;
    this.readyHandler = null;
    this.loadState = "initial";
    this.contextRevision = 0;
  }
}
