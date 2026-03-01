export type ThemeMode = "system" | "light" | "dark";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  password: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeMode;
  chatFocusMode: boolean;
  chatShowThinking: boolean;
  splitRatio: number;
  navCollapsed: boolean;
  navGroupsCollapsed: Record<string, boolean>;
  chatSidebarCollapsed: boolean;
  configSidebarCollapsed: boolean;
  agentsSidebarCollapsed: boolean;
};

const KEY = "openclaw.control.settings.v1";

export function loadSettings(): UiSettings {
  const defaultUrl = (() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    if (import.meta.env.DEV) {
      // In dev mode, proxy through the Vite dev server to avoid cross-origin
      // self-signed cert issues. The /gw-ws path is forwarded to the gateway.
      return `${proto}://${location.host}/gw-ws`;
    }
    // In production the UI is served by the gateway itself — same origin.
    return `${proto}://${location.host}`;
  })();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: "",
    password: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navGroupsCollapsed: {},
    chatSidebarCollapsed: false,
    configSidebarCollapsed: false,
    agentsSidebarCollapsed: false,
  };

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return {
      gatewayUrl: (() => {
        const saved =
          typeof parsed.gatewayUrl === "string" && parsed.gatewayUrl.trim()
            ? parsed.gatewayUrl.trim()
            : defaults.gatewayUrl;
        // In dev mode, migrate stale direct-to-gateway URLs to the Vite proxy
        // path so the browser never makes a cross-origin WSS connection.
        if (import.meta.env.DEV && /^wss?:\/\/[^/]+:18789\/?$/.test(saved)) {
          return defaults.gatewayUrl;
        }
        return saved;
      })(),
      token: typeof parsed.token === "string" ? parsed.token : defaults.token,
      password: typeof parsed.password === "string" ? parsed.password : defaults.password,
      sessionKey:
        typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
          ? parsed.sessionKey.trim()
          : defaults.sessionKey,
      lastActiveSessionKey:
        typeof parsed.lastActiveSessionKey === "string" && parsed.lastActiveSessionKey.trim()
          ? parsed.lastActiveSessionKey.trim()
          : (typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()) ||
            defaults.lastActiveSessionKey,
      theme:
        parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
          ? parsed.theme
          : defaults.theme,
      chatFocusMode:
        typeof parsed.chatFocusMode === "boolean" ? parsed.chatFocusMode : defaults.chatFocusMode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navGroupsCollapsed:
        typeof parsed.navGroupsCollapsed === "object" && parsed.navGroupsCollapsed !== null
          ? parsed.navGroupsCollapsed
          : defaults.navGroupsCollapsed,
      chatSidebarCollapsed:
        typeof parsed.chatSidebarCollapsed === "boolean"
          ? parsed.chatSidebarCollapsed
          : defaults.chatSidebarCollapsed,
      configSidebarCollapsed:
        typeof parsed.configSidebarCollapsed === "boolean"
          ? parsed.configSidebarCollapsed
          : defaults.configSidebarCollapsed,
      agentsSidebarCollapsed:
        typeof parsed.agentsSidebarCollapsed === "boolean"
          ? parsed.agentsSidebarCollapsed
          : defaults.agentsSidebarCollapsed,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  localStorage.setItem(KEY, JSON.stringify(next));
}
