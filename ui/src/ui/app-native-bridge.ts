type WebView2Bridge = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

type TauriCoreBridge = {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
};

type TauriGlobalBridge = {
  core?: TauriCoreBridge;
};

const DESKTOP_GATEWAY_PORT = 18789;

export type NativeBridgeMessage =
  | { type: "draft-text"; payload: { text: string } }
  | { type: "ready"; payload?: Record<string, unknown> };

export type DesktopGatewayStateUpdate = {
  starting?: boolean;
  started?: boolean;
  error?: string | null;
  url?: string | null;
  token?: string | null;
};

export type DesktopPermissionEntry = {
  id: string;
  label: string;
  status: string;
  settingsUrl?: string | null;
  settings_url?: string | null;
};

export type DesktopStatus = {
  gateway?: {
    running?: boolean;
    url?: string;
    started_at_ms?: number | null;
    auth_token?: string | null;
  };
  runtime?: {
    launcher_path?: string | null;
    manifest_path?: string | null;
    bundled_lobster?: boolean;
    packaged_runtime?: boolean;
    runtime_source?: string;
    openclaw_version?: string | null;
    node_version?: string | null;
    desktop_app_update_mode?: string | null;
    desktop_app_update_url?: string | null;
  };
  capabilities?: {
    gateway_update_supported?: boolean;
    desktop_app_update_supported?: boolean;
    packaged_runtime_update_supported?: boolean;
    external_plugin_install_supported?: boolean;
    native_notifications_supported?: boolean;
    web_push_replaced_by_native?: boolean;
  };
  permissions?: {
    platform?: string;
    entries?: DesktopPermissionEntry[];
  };
};

export type DesktopCommandResult = {
  code?: number | null;
  signal?: number | null;
  stdout?: string;
  stderr?: string;
};

export type DesktopCliStatus = {
  installed?: boolean;
  version?: string | null;
  package_managers?: Record<string, string | null>;
  packageManagers?: Record<string, string | null>;
  preferred_manager?: string | null;
  preferredManager?: string | null;
  install_spec?: string | null;
  installSpec?: string | null;
};

export type DesktopNotificationStatus = {
  supported?: boolean;
  permission?: NotificationPermission | "unsupported";
};

export type DesktopAppUpdateStatus = {
  configured?: boolean;
  available?: boolean;
  current_version?: string;
  currentVersion?: string;
  version?: string | null;
  body?: string | null;
  date?: string | null;
  error?: string | null;
};

export type NativeBridgeHost = {
  handleChatDraftChange: (next: string) => void;
  connect?: () => void;
  setDesktopGatewayState?: (next: DesktopGatewayStateUpdate) => void;
  setDesktopStatus?: (next: DesktopStatus | null) => void;
};

function getWebview(): WebView2Bridge | undefined {
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  return webview;
}

function getTauri(): TauriGlobalBridge | undefined {
  return (window as unknown as { __TAURI__?: TauriGlobalBridge })["__TAURI__"];
}

export function isWebView2(): boolean {
  return getWebview() !== undefined;
}

export function isTauriDesktop(): boolean {
  return getTauri()?.core?.invoke !== undefined;
}

function sendToTauri(msg: NativeBridgeMessage): void {
  void getTauri()
    ?.core?.invoke("desktop_native_message", { message: msg })
    .catch((err: unknown) => {
      console.error("[native] Tauri native message failed:", err);
    });
}

function formatNativeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startTauriDesktopGateway(host: NativeBridgeHost): Promise<void> {
  await startOrRestartTauriDesktopGateway(host, "desktop_start_gateway");
}

export async function restartTauriDesktopGateway(host: NativeBridgeHost): Promise<void> {
  await startOrRestartTauriDesktopGateway(host, "desktop_restart_gateway");
}

async function startOrRestartTauriDesktopGateway(
  host: NativeBridgeHost,
  command: "desktop_start_gateway" | "desktop_restart_gateway",
): Promise<void> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    return;
  }
  host.setDesktopGatewayState?.({ starting: true, error: null });
  try {
    const status = await tauri.core.invoke<{
      running?: boolean;
      url?: string;
      auth_token?: string | null;
    }>(command, { port: DESKTOP_GATEWAY_PORT });
    const refreshed = await refreshTauriDesktopStatus(host);
    const gateway = refreshed?.gateway;
    const resolvedUrl = typeof gateway?.url === "string" ? gateway.url : status?.url;
    const resolvedToken =
      typeof gateway?.auth_token === "string" ? gateway.auth_token : status?.auth_token;
    host.setDesktopGatewayState?.({
      starting: false,
      started: Boolean(gateway?.running ?? status?.running),
      error: null,
      url: typeof resolvedUrl === "string" ? resolvedUrl : null,
      token: typeof resolvedToken === "string" ? resolvedToken : null,
    });
    host.connect?.();
  } catch (err) {
    host.setDesktopGatewayState?.({
      starting: false,
      started: false,
      error: formatNativeError(err),
    });
    console.error("[native] Tauri gateway start failed:", err);
  }
}

export async function refreshTauriDesktopStatus(
  host: NativeBridgeHost,
): Promise<DesktopStatus | null> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    host.setDesktopStatus?.(null);
    return null;
  }
  try {
    const status = await tauri.core.invoke<DesktopStatus>("desktop_status", {});
    host.setDesktopStatus?.(status);
    const gateway = status?.gateway;
    if (gateway?.running && typeof gateway.url === "string") {
      host.setDesktopGatewayState?.({
        starting: false,
        started: true,
        error: null,
        url: gateway.url,
        token: typeof gateway.auth_token === "string" ? gateway.auth_token : null,
      });
    }
    return status;
  } catch (err) {
    console.error("[native] Tauri desktop status failed:", err);
    host.setDesktopStatus?.(null);
    return null;
  }
}

export async function openDesktopPermissionSettings(permissionId: string): Promise<void> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    return;
  }
  await tauri.core.invoke("desktop_open_permission_settings", { permissionId });
}

export async function installDesktopPlugin(source: string): Promise<DesktopCommandResult> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    throw new Error("Desktop plugin install is only available in the desktop app.");
  }
  return await tauri.core.invoke<DesktopCommandResult>("desktop_install_plugin", { source });
}

export async function getDesktopCliStatus(): Promise<DesktopCliStatus> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    return { installed: false };
  }
  return await tauri.core.invoke<DesktopCliStatus>("desktop_cli_status", {});
}

export async function installDesktopCli(manager = "auto"): Promise<DesktopCommandResult> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    throw new Error("Desktop CLI install is only available in the desktop app.");
  }
  return await tauri.core.invoke<DesktopCommandResult>("desktop_install_cli", { manager });
}

export async function openDesktopAppUpdatePage(): Promise<void> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    return;
  }
  await tauri.core.invoke("desktop_open_app_update_page", {});
}

export async function checkDesktopAppUpdate(): Promise<DesktopAppUpdateStatus> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    return { configured: false, available: false };
  }
  return await tauri.core.invoke<DesktopAppUpdateStatus>("desktop_check_app_update", {});
}

export async function installDesktopAppUpdate(): Promise<DesktopAppUpdateStatus> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    throw new Error("Desktop app updates are only available in the desktop app.");
  }
  return await tauri.core.invoke<DesktopAppUpdateStatus>("desktop_install_app_update", {});
}

function normalizeDesktopNotificationStatus(
  status: DesktopNotificationStatus | null | undefined,
): Required<DesktopNotificationStatus> {
  const permission = status?.permission;
  return {
    supported: Boolean(status?.supported),
    permission:
      permission === "granted" ||
      permission === "denied" ||
      permission === "default" ||
      permission === "unsupported"
        ? permission
        : "unsupported",
  };
}

export async function getDesktopNotificationStatus(): Promise<Required<DesktopNotificationStatus>> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    return { supported: false, permission: "unsupported" };
  }
  return normalizeDesktopNotificationStatus(
    await tauri.core.invoke<DesktopNotificationStatus>("desktop_notification_status_command", {}),
  );
}

export async function requestDesktopNotificationPermission(): Promise<
  Required<DesktopNotificationStatus>
> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    return { supported: false, permission: "unsupported" };
  }
  return normalizeDesktopNotificationStatus(
    await tauri.core.invoke<DesktopNotificationStatus>(
      "desktop_request_notification_permission",
      {},
    ),
  );
}

export async function sendDesktopNotificationTest(): Promise<Required<DesktopNotificationStatus>> {
  const tauri = getTauri();
  if (!tauri?.core?.invoke) {
    throw new Error("Desktop notifications are only available in the desktop app.");
  }
  return normalizeDesktopNotificationStatus(
    await tauri.core.invoke<DesktopNotificationStatus>("desktop_send_notification_test", {}),
  );
}

export function sendToNative(msg: NativeBridgeMessage): void {
  const webview = getWebview();
  if (webview) {
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- WebView2 host postMessage has no targetOrigin parameter.
    webview.postMessage(msg);
    return;
  }
  if (isTauriDesktop()) {
    sendToTauri(msg);
  }
}

function handleNativeMessage(host: NativeBridgeHost, raw: unknown): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== "string") {
    return;
  }
  if (msg.type === "draft-text") {
    const text =
      msg.payload && typeof msg.payload === "object"
        ? (msg.payload as Record<string, unknown>).text
        : undefined;
    if (typeof text === "string") {
      host.handleChatDraftChange(text);
    }
  }
}

/**
 * Subscribes to native messages and sends the ready handshake.
 * addEventListener is called BEFORE the ready handshake so no messages
 * are missed between the handshake and the first listen.
 * Returns a cleanup function that removes the listener.
 * No-op (returns empty cleanup) when not running inside WebView2 or Tauri.
 */
export function initNativeBridge(host: NativeBridgeHost): () => void {
  const bridge = getWebview();
  if (!bridge) {
    if (isTauriDesktop()) {
      sendToNative({ type: "ready" });
      void refreshTauriDesktopStatus(host);
      void startTauriDesktopGateway(host);
    }
    return () => undefined;
  }

  const handler = (event: MessageEvent) => {
    handleNativeMessage(host, event.data);
  };

  bridge.addEventListener("message", handler);
  sendToNative({ type: "ready" });

  return () => {
    bridge.removeEventListener("message", handler);
  };
}
