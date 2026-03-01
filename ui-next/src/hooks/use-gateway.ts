import { createContext, useContext, useEffect, useRef, useCallback } from "react";
import { GatewayBrowserClient, type GatewayEventFrame } from "@/lib/gateway-client";
import { loadSettings, saveSettings } from "@/lib/storage";
import { useChatStore } from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";

/** Extract token/session/gatewayUrl/password from query string or hash fragment, save to settings, strip from URL. */
function applyUrlParams() {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const settings = loadSettings();
  let changed = false;

  const tokenRaw = params.get("token") ?? hashParams.get("token");
  if (tokenRaw != null) {
    const token = tokenRaw.trim();
    if (token && token !== settings.token) {
      settings.token = token;
      changed = true;
    }
    params.delete("token");
    hashParams.delete("token");
  }

  const passwordRaw = params.get("password") ?? hashParams.get("password");
  if (passwordRaw != null) {
    const password = passwordRaw.trim();
    if (password && password !== settings.password) {
      settings.password = password;
      changed = true;
    }
    params.delete("password");
    hashParams.delete("password");
  }

  const sessionRaw = params.get("session") ?? hashParams.get("session");
  if (sessionRaw != null) {
    const sessionKey = sessionRaw.trim();
    if (sessionKey) {
      settings.sessionKey = sessionKey;
      settings.lastActiveSessionKey = sessionKey;
      changed = true;
    }
    params.delete("session");
    hashParams.delete("session");
  }

  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  if (gatewayUrlRaw != null) {
    const gatewayUrl = gatewayUrlRaw.trim();
    if (gatewayUrl) {
      settings.gatewayUrl = gatewayUrl;
      changed = true;
    }
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
  }

  if (changed) {
    saveSettings(settings);
  }

  // Strip consumed params from URL without reload
  const remaining = params.toString();
  const hashRemaining = hashParams.toString();
  const cleanUrl = `${window.location.pathname}${remaining ? `?${remaining}` : ""}${hashRemaining ? `#${hashRemaining}` : ""}`;
  window.history.replaceState(null, "", cleanUrl);
}

// --- Context for sharing a single gateway connection ---

type SendRpcFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

type GatewayContextValue = {
  sendRpc: SendRpcFn;
};

export const GatewayContext = createContext<GatewayContextValue | null>(null);

/**
 * Hook that establishes the gateway WebSocket connection.
 * Must be called exactly once, inside GatewayProvider.
 */
export function useGatewayConnection(): GatewayContextValue {
  const clientRef = useRef<GatewayBrowserClient | null>(null);

  useEffect(() => {
    applyUrlParams();
    const settings = loadSettings();
    // Use getState() instead of subscribing to the whole store — avoids
    // unnecessary re-renders of the provider component on every store update.
    useGatewayStore.getState().setConnectionStatus("connecting");

    const client = new GatewayBrowserClient({
      url: settings.gatewayUrl,
      token: settings.token.trim() ? settings.token : undefined,
      password: settings.password.trim() ? settings.password : undefined,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      onHello: (hello) => {
        useGatewayStore.getState().applySnapshot(hello);
      },
      onClose: ({ code, reason }) => {
        const store = useGatewayStore.getState();
        // 1012 = Service Restart (expected during config saves)
        if (code !== 1012) {
          store.setLastError(`disconnected (${code}): ${reason || "no reason"}`);
        }
        store.setConnectionStatus("disconnected");
        // Clear stale streaming state — the run is gone if the connection dropped
        const chatState = useChatStore.getState();
        if (chatState.isStreaming || chatState.isSendPending) {
          chatState.finalizeStream(
            chatState.streamRunId ?? "",
            chatState.streamContent || undefined,
          );
          chatState.setSendPending(false);
        }
      },
      onEvent: (evt: GatewayEventFrame) => {
        useGatewayStore.getState().pushEvent(evt.event, evt.payload);
        handleEvent(evt);
      },
      onGap: ({ expected, received }) => {
        useGatewayStore
          .getState()
          .setLastError(
            `event gap detected (expected seq ${expected}, got ${received}); refresh recommended`,
          );
      },
    });

    clientRef.current = client;
    client.start();

    return () => {
      client.stop();
      clientRef.current = null;
      useGatewayStore.getState().reset();
    };
  }, []);

  const sendRpc = useCallback(<T = unknown>(method: string, params?: unknown): Promise<T> => {
    const client = clientRef.current;
    if (!client) {
      return Promise.reject(new Error("gateway not connected"));
    }
    return client.request<T>(method, params);
  }, []);

  return { sendRpc };
}

/**
 * Consume the shared gateway connection from any child component.
 * The connection is established once by GatewayProvider in the Shell layout.
 */
export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) {
    throw new Error("useGateway must be used within GatewayProvider (Shell)");
  }
  return ctx;
}

function handleEvent(evt: GatewayEventFrame) {
  const store = useGatewayStore.getState();

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: unknown[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      store.setPresenceEntries(payload.presence as typeof store.presenceEntries);
    }
  }

  if (evt.event === "chat") {
    handleChatEvent(evt.payload);
  }
}

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: "started" | "delta" | "final" | "error";
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    timestamp?: number;
  };
  errorMessage?: string;
};

function handleChatEvent(payload: unknown) {
  const chatStore = useChatStore.getState();
  const evt = payload as ChatEventPayload;
  if (!evt?.runId) {
    return;
  }

  const { runId, state, sessionKey } = evt;

  // Ignore events for other sessions
  if (sessionKey && sessionKey !== chatStore.activeSessionKey) {
    return;
  }

  // Any chat event means the server is handling our request — clear pending
  if (chatStore.isSendPending) {
    chatStore.setSendPending(false);
  }

  // Auto-initialize stream if we haven't seen a "started" event yet.
  // The server may skip "started" and go straight to "delta" or "final".
  if (state !== "started" && chatStore.streamRunId !== runId) {
    chatStore.startStream(runId);
  }

  switch (state) {
    case "started":
      chatStore.startStream(runId);
      break;
    case "delta": {
      const text = evt.message?.content?.[0]?.text ?? "";
      chatStore.updateStreamDelta(runId, text);
      break;
    }
    case "final": {
      const text = evt.message?.content?.[0]?.text;
      chatStore.finalizeStream(runId, text);
      break;
    }
    case "error":
      chatStore.streamError(runId, evt.errorMessage);
      break;
  }
}
