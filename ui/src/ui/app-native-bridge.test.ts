import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDesktopAppUpdate,
  getDesktopNotificationStatus,
  getDesktopCliStatus,
  installDesktopAppUpdate,
  installDesktopPlugin,
  installDesktopCli,
  initNativeBridge,
  isTauriDesktop,
  isWebView2,
  openDesktopAppUpdatePage,
  refreshTauriDesktopStatus,
  requestDesktopNotificationPermission,
  restartTauriDesktopGateway,
  sendDesktopNotificationTest,
  sendToNative,
  startTauriDesktopGateway,
} from "./app-native-bridge.ts";
import {
  handleChatDraftChange as applyDraftChange,
  navigateChatInputHistory,
  type ChatInputHistoryState,
} from "./chat/input-history.ts";

type FakeBridge = {
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: ((e: MessageEvent) => void)[];
  posted: unknown[];
};

function makeBridge(): FakeBridge {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const posted: unknown[] = [];
  const bridge: FakeBridge = {
    posted,
    listeners,
    postMessage: vi.fn((msg: unknown) => posted.push(msg)),
    addEventListener: vi.fn((_type: string, fn: (e: MessageEvent) => void) => listeners.push(fn)),
    removeEventListener: vi.fn((_type: string, fn: (e: MessageEvent) => void) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) {
        listeners.splice(i, 1);
      }
    }),
  };
  vi.stubGlobal("chrome", { webview: bridge });
  return bridge;
}

function makeHost() {
  return { handleChatDraftChange: vi.fn() };
}

function makeTauriBridge(params?: { gatewayError?: unknown }) {
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === "desktop_start_gateway" || command === "desktop_restart_gateway") {
      if (params?.gatewayError) {
        return Promise.reject(params.gatewayError);
      }
      return Promise.resolve({
        running: true,
        url: "ws://127.0.0.1:18789",
        auth_token: "desktop-token",
      });
    }
    if (command === "desktop_status") {
      return Promise.resolve({
        gateway: {
          running: true,
          url: "ws://127.0.0.1:18789",
          auth_token: "desktop-token",
        },
        runtime: { packaged_runtime: true, runtime_source: "packaged-runtime" },
        capabilities: {
          gateway_update_supported: false,
          external_plugin_install_supported: true,
        },
      });
    }
    if (command === "desktop_install_plugin") {
      return Promise.resolve({
        code: 0,
        stdout: `installed ${String(args?.source ?? "")}`,
        stderr: "",
      });
    }
    if (command === "desktop_cli_status") {
      return Promise.resolve({
        installed: false,
        version: null,
        package_managers: { npm: "11.0.0", pnpm: null, bun: null },
        preferred_manager: "npm",
        install_spec: "openclaw@2026.5.25",
      });
    }
    if (command === "desktop_install_cli") {
      return Promise.resolve({
        code: 0,
        stdout: `installed cli with ${String(args?.manager ?? "")}`,
        stderr: "",
      });
    }
    if (command === "desktop_open_app_update_page") {
      return Promise.resolve(null);
    }
    if (command === "desktop_check_app_update") {
      return Promise.resolve({
        configured: true,
        available: true,
        current_version: "2026.5.25",
        version: "2026.5.26",
      });
    }
    if (command === "desktop_install_app_update") {
      return Promise.resolve({
        configured: true,
        available: true,
        current_version: "2026.5.25",
        version: "2026.5.26",
      });
    }
    if (
      command === "desktop_notification_status_command" ||
      command === "desktop_request_notification_permission" ||
      command === "desktop_send_notification_test"
    ) {
      return Promise.resolve({ supported: true, permission: "granted" });
    }
    return Promise.resolve(null);
  });
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  return { invoke };
}

function dispatch(bridge: FakeBridge, data: unknown) {
  const event = { data } as MessageEvent;
  for (const fn of bridge.listeners) {
    fn(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWebView2", () => {
  it("returns false when window.chrome.webview is absent", () => {
    expect(isWebView2()).toBe(false);
  });

  it("returns true when window.chrome.webview is present", () => {
    makeBridge();
    expect(isWebView2()).toBe(true);
  });
});

describe("isTauriDesktop", () => {
  it("returns false when Tauri invoke is absent", () => {
    expect(isTauriDesktop()).toBe(false);
  });

  it("returns true when Tauri invoke is present", () => {
    makeTauriBridge();
    expect(isTauriDesktop()).toBe(true);
  });
});

describe("sendToNative", () => {
  it("posts the message to the webview", () => {
    const bridge = makeBridge();
    sendToNative({ type: "ready" });
    expect(bridge.posted).toEqual([{ type: "ready" }]);
  });

  it("does nothing outside WebView2", () => {
    expect(sendToNative({ type: "ready" })).toBeUndefined();
  });

  it("forwards messages through the Tauri bridge", async () => {
    const tauri = makeTauriBridge();
    sendToNative({ type: "ready" });
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith("desktop_native_message", {
        message: { type: "ready" },
      });
    });
  });
});

describe("initNativeBridge", () => {
  it("registers listener before sending ready handshake", () => {
    const callOrder: string[] = [];
    const webview = {
      postMessage: vi.fn(() => callOrder.push("post")),
      addEventListener: vi.fn(() => callOrder.push("listen")),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("chrome", { webview });
    initNativeBridge(makeHost());
    expect(callOrder).toEqual(["listen", "post"]);
  });

  it("sends ready handshake on init", () => {
    const bridge = makeBridge();
    initNativeBridge(makeHost());
    expect(bridge.posted).toEqual([{ type: "ready" }]);
  });

  it("is a no-op outside WebView2", () => {
    const host = makeHost();
    const cleanup = initNativeBridge(host);
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
    expect(cleanup()).toBeUndefined();
  });

  it("starts the Tauri desktop gateway and sends ready", async () => {
    const tauri = makeTauriBridge();
    const cleanup = initNativeBridge(makeHost());
    expect(cleanup()).toBeUndefined();
    await vi.waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith("desktop_native_message", {
        message: { type: "ready" },
      });
      expect(tauri.invoke).toHaveBeenCalledWith("desktop_start_gateway", { port: 18789 });
    });
  });

  it("marks the desktop gateway started and connects after Tauri starts it", async () => {
    makeTauriBridge();
    const host = {
      ...makeHost(),
      connect: vi.fn(),
      setDesktopGatewayState: vi.fn(),
    };

    await startTauriDesktopGateway(host);

    expect(host.setDesktopGatewayState).toHaveBeenNthCalledWith(1, {
      starting: true,
      error: null,
    });
    expect(host.setDesktopGatewayState).toHaveBeenNthCalledWith(2, {
      starting: false,
      started: true,
      error: null,
      url: "ws://127.0.0.1:18789",
      token: "desktop-token",
    });
    expect(host.setDesktopGatewayState).toHaveBeenNthCalledWith(3, {
      starting: false,
      started: true,
      error: null,
      url: "ws://127.0.0.1:18789",
      token: "desktop-token",
    });
    expect(host.connect).toHaveBeenCalledOnce();
  });

  it("surfaces Tauri gateway start failures without connecting", async () => {
    makeTauriBridge({ gatewayError: new Error("launcher missing") });
    const host = {
      ...makeHost(),
      connect: vi.fn(),
      setDesktopGatewayState: vi.fn(),
    };

    await startTauriDesktopGateway(host);

    expect(host.setDesktopGatewayState).toHaveBeenLastCalledWith({
      starting: false,
      started: false,
      error: "launcher missing",
    });
    expect(host.connect).not.toHaveBeenCalled();
  });

  it("restarts the Tauri desktop gateway and reconnects", async () => {
    const tauri = makeTauriBridge();
    const host = {
      ...makeHost(),
      connect: vi.fn(),
      setDesktopGatewayState: vi.fn(),
    };

    await restartTauriDesktopGateway(host);

    expect(tauri.invoke).toHaveBeenCalledWith("desktop_restart_gateway", { port: 18789 });
    expect(host.setDesktopGatewayState).toHaveBeenLastCalledWith({
      starting: false,
      started: true,
      error: null,
      url: "ws://127.0.0.1:18789",
      token: "desktop-token",
    });
    expect(host.connect).toHaveBeenCalledOnce();
  });

  it("loads desktop status through Tauri", async () => {
    const tauri = makeTauriBridge();
    const host = { ...makeHost(), setDesktopGatewayState: vi.fn(), setDesktopStatus: vi.fn() };

    const status = await refreshTauriDesktopStatus(host);

    expect(status?.runtime?.packaged_runtime).toBe(true);
    expect(host.setDesktopStatus).toHaveBeenCalledWith(status);
    expect(host.setDesktopGatewayState).toHaveBeenCalledWith({
      starting: false,
      started: true,
      error: null,
      url: "ws://127.0.0.1:18789",
      token: "desktop-token",
    });
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_status", {});
  });

  it("installs desktop plugins through the constrained Tauri command", async () => {
    const tauri = makeTauriBridge();

    const result = await installDesktopPlugin("clawhub:owner/example");

    expect(result).toMatchObject({ code: 0, stdout: "installed clawhub:owner/example" });
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_install_plugin", {
      source: "clawhub:owner/example",
    });
  });

  it("checks and installs the desktop CLI helper through Tauri", async () => {
    const tauri = makeTauriBridge();

    await expect(getDesktopCliStatus()).resolves.toMatchObject({
      installed: false,
      preferred_manager: "npm",
      install_spec: "openclaw@2026.5.25",
    });
    await expect(installDesktopCli("auto")).resolves.toMatchObject({
      code: 0,
      stdout: "installed cli with auto",
    });

    expect(tauri.invoke).toHaveBeenCalledWith("desktop_cli_status", {});
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_install_cli", { manager: "auto" });
  });

  it("opens the desktop app update page through Tauri", async () => {
    const tauri = makeTauriBridge();

    await openDesktopAppUpdatePage();

    expect(tauri.invoke).toHaveBeenCalledWith("desktop_open_app_update_page", {});
  });

  it("checks and installs signed desktop app updates through Tauri", async () => {
    const tauri = makeTauriBridge();

    await expect(checkDesktopAppUpdate()).resolves.toMatchObject({
      configured: true,
      available: true,
      version: "2026.5.26",
    });
    await expect(installDesktopAppUpdate()).resolves.toMatchObject({
      configured: true,
      available: true,
      version: "2026.5.26",
    });

    expect(tauri.invoke).toHaveBeenCalledWith("desktop_check_app_update", {});
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_install_app_update", {});
  });

  it("uses native Tauri notification commands for desktop notifications", async () => {
    const tauri = makeTauriBridge();

    await expect(getDesktopNotificationStatus()).resolves.toEqual({
      supported: true,
      permission: "granted",
    });
    await expect(requestDesktopNotificationPermission()).resolves.toEqual({
      supported: true,
      permission: "granted",
    });
    await expect(sendDesktopNotificationTest()).resolves.toEqual({
      supported: true,
      permission: "granted",
    });

    expect(tauri.invoke).toHaveBeenCalledWith("desktop_notification_status_command", {});
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_request_notification_permission", {});
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_send_notification_test", {});
  });

  it("calls handleChatDraftChange for a valid draft-text message", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, { type: "draft-text", payload: { text: "hello from native" } });
    expect(host.handleChatDraftChange).toHaveBeenCalledWith("hello from native");
  });

  it("ignores draft-text with missing payload", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, { type: "draft-text" });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("ignores draft-text with non-string text", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, { type: "draft-text", payload: { text: 42 } });
    dispatch(bridge, { type: "draft-text", payload: { text: null } });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("ignores unknown message types", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, { type: "recording-start" });
    dispatch(bridge, { type: "voice-start" });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("ignores null, primitives, and messages without a type string", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, null);
    dispatch(bridge, "string");
    dispatch(bridge, 42);
    dispatch(bridge, {});
    dispatch(bridge, { type: 99 });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("removes the listener on cleanup", () => {
    const bridge = makeBridge();
    const host = makeHost();
    const cleanup = initNativeBridge(host);
    expect(bridge.listeners).toHaveLength(1);
    const registeredListener = bridge.listeners[0];
    cleanup();
    expect(bridge.listeners).toHaveLength(0);
    expect(bridge.removeEventListener).toHaveBeenCalledWith("message", registeredListener);
  });

  it("does not call handleChatDraftChange after cleanup", () => {
    const bridge = makeBridge();
    const host = makeHost();
    const cleanup = initNativeBridge(host);
    cleanup();
    dispatch(bridge, { type: "draft-text", payload: { text: "after cleanup" } });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("draft-text resets input-history navigation — same effect as a user edit", () => {
    const bridge = makeBridge();

    const state: ChatInputHistoryState = {
      sessionKey: "s1",
      chatLoading: false,
      chatMessage: "",
      chatMessages: [],
      chatLocalInputHistoryBySession: { s1: [{ text: "previous input", ts: 1 }] },
      chatInputHistorySessionKey: null,
      chatInputHistoryItems: null,
      chatInputHistoryIndex: -1,
      chatDraftBeforeHistory: null,
    };

    // Simulate the user having navigated into history (index is now active).
    navigateChatInputHistory(state, "up");
    expect(state.chatInputHistoryIndex).toBe(0);

    // Host delegates to the real handleChatDraftChange — same path as app.ts.
    const host = { handleChatDraftChange: (text: string) => applyDraftChange(state, text) };
    initNativeBridge(host);

    dispatch(bridge, { type: "draft-text", payload: { text: "native injection" } });

    expect(state.chatMessage).toBe("native injection");
    expect(state.chatInputHistoryIndex).toBe(-1);
    expect(state.chatInputHistoryItems).toBeNull();
    expect(state.chatInputHistorySessionKey).toBeNull();
  });
});
