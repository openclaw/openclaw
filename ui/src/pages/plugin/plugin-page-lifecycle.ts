import type { JSX } from "@solidjs/web";
import type { ControlUiPluginFrameGrantAck } from "../../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
  resolveControlUiPluginTabPathname,
} from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "../../app/stale-chunk-reload.ts";
import { uiDevGatewayResourceUrl } from "../../dev-gateway.ts";
import { postWidgetTheme, registerWidgetThemeFrame } from "../../lib/widget-theme.ts";
import type { LogbookProps } from "./logbook-view.tsx";
import { openPluginFrameSession } from "./plugin-frame-session-navigation.ts";
import { pluginTabKey } from "./route.ts";

/**
 * Views shipped with the Control UI use this adapter. Native plugin entries
 * mount through the contribution runtime; descriptor paths use sandboxed frames.
 */
type BundledPluginTabView = {
  render: (props: LogbookProps) => JSX.Element;
  stop: (host: object) => void;
};

type BundledPluginTabViewState =
  | { status: "idle" }
  | { status: "loading"; id: string }
  | { status: "error"; id: string; error: unknown }
  | { status: "ready"; id: string; view: BundledPluginTabView };

function pluginFrameGrantCoversTab(
  grant: ControlUiPluginFrameGrantAck,
  info: GatewayControlUiPluginTab,
): boolean {
  if (!info.path || grant.pluginId !== info.pluginId) {
    return false;
  }
  const tabPath = resolveControlUiPluginTabPathname(info.path);
  if (!tabPath) {
    return false;
  }
  return (
    tabPath === grant.path ||
    (grant.match !== "exact" &&
      tabPath.startsWith(grant.path) &&
      (grant.path.endsWith("/") || tabPath.at(grant.path.length) === "/"))
  );
}

const EXTERNAL_AUTH_REFRESH_TIMEOUT_MS = 10_000;
const EXTERNAL_AUTH_PROBE_TIMEOUT_MS = 5_000;

// Keyed by pluginId/tabId: tab ids are only unique within their plugin.
export const BUNDLED_TAB_VIEWS: Record<string, () => Promise<BundledPluginTabView>> = {
  "logbook/logbook": async () => {
    const [{ Logbook }, { stopLogbookPolling }] = await Promise.all([
      import("./logbook-view.tsx"),
      import("./logbook-controller.ts"),
    ]);
    return { render: Logbook, stop: stopLogbookPolling };
  },
};

export type PluginPageProps = {
  pluginId?: string;
  tabId?: string;
  params?: Readonly<Record<string, string>>;
};

// Auth grants and retired frame epochs must change synchronously at the effect boundary.
// Solid observes the lifecycle; its deferred signal writes never own these facts.
export class PluginPageLifecycle {
  private disposed = false;
  bundledViewState: BundledPluginTabViewState = { status: "idle" };
  externalAuthReadyKey: string | null = null;
  externalAuthUnavailableKey: string | null = null;
  pluginFrameGeneration: object = {};

  constructor(
    readonly props: PluginPageProps,
    readonly context: ApplicationContext,
    private readonly host: HTMLElement,
    private readonly notify: () => void,
  ) {
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("message", this.handlePluginSessionOpen);
  }

  bundledViewHost: object = {};
  private gatewaySource?: ApplicationContext["gateway"];
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private gatewayHello: ApplicationContext["gateway"]["snapshot"]["hello"] = null;
  private gatewayConnectionRevision = 0;
  private externalAuthTargetKey: string | null = null;
  private externalAuthRefreshAbortController: AbortController | null = null;
  private externalAuthRefreshWatchdog: ReturnType<typeof setTimeout> | null = null;
  private externalAuthProbeAbortController: AbortController | null = null;
  private externalAuthRestartKey: string | null = null;
  private externalAuthRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private externalAuthExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private externalAuthRefreshedAt = 0;
  private pluginThemeFrame: HTMLIFrameElement | null = null;
  private releasePluginTheme: (() => void) | null = null;
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState !== "visible" || !this.externalAuthTargetKey) {
      return;
    }
    if (Date.now() - this.externalAuthRefreshedAt >= CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS) {
      // A suspended browser may miss renewal timers. Remove an expired frame
      // until the parent refreshes its route-bound cookie on resume.
      this.externalAuthReadyKey = null;
      this.externalAuthRefreshedAt = 0;
      this.pluginFrameGeneration = {};
      this.requestExternalTabAuthRestart(this.externalAuthTargetKey);
      this.notify();
      return;
    }
    this.refreshExternalTabAuth(this.externalAuthTargetKey);
  };

  dispose() {
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("message", this.handlePluginSessionOpen);
    this.syncPluginThemeFrame(null);
    this.clearExternalTabAuth();
    this.stopBundledView();
  }

  tabKey(): string {
    return pluginTabKey({ pluginId: this.props.pluginId ?? "", id: this.props.tabId ?? "" });
  }

  private loadBundledView(key: string): Promise<BundledPluginTabView> {
    const load = BUNDLED_TAB_VIEWS[key];
    return load ? load() : Promise.reject(new Error(`Unknown bundled plugin tab: ${key}`));
  }

  private hasCurrentBundledDescriptor(key: string): boolean {
    return this.tabKey() === key && this.tabInfo() !== undefined && key in BUNDLED_TAB_VIEWS;
  }

  private startBundledViewLoad(key: string) {
    const loading = { status: "loading", id: key } as const;
    this.bundledViewState = loading;
    this.notify();
    const settle = (nextState: BundledPluginTabViewState) => {
      if (this.bundledViewState !== loading || !this.hasCurrentBundledDescriptor(key)) {
        return;
      }
      this.bundledViewState = nextState;
      this.notify();
      if (nextState.status === "error" && isStaleChunkImportError(nextState.error)) {
        void scheduleStaleChunkReload();
      }
    };
    void this.loadBundledView(key).then(
      (view) => settle({ status: "ready", id: key, view }),
      (error: unknown) => settle({ status: "error", id: key, error }),
    );
  }

  readonly retryBundledView = () => {
    const viewState = this.bundledViewState;
    if (viewState.status !== "error" || !this.hasCurrentBundledDescriptor(viewState.id)) {
      return;
    }
    if (isStaleChunkImportError(viewState.error)) {
      void retryStaleChunkReloadWhenReachable();
    } else {
      this.startBundledViewLoad(viewState.id);
    }
  };

  readonly update = () => {
    this.updateGatewaySource(this.context.gateway);
    if (this.disposed) {
      return;
    }
    const key = this.tabKey();
    const info = this.tabInfo();
    const hasBundledDescriptor = info !== undefined && key in BUNDLED_TAB_VIEWS;
    const viewState = this.bundledViewState;
    // Switching between plugin tabs reuses this element; the previous bundled
    // view must stop its background polling before the next one renders. A
    // descriptor can also disappear in place after disablement or scope loss.
    if (viewState.status !== "idle" && (viewState.id !== key || !hasBundledDescriptor)) {
      this.stopBundledView();
    }
    if (this.bundledViewState.status === "idle" && hasBundledDescriptor) {
      this.startBundledViewLoad(key);
    }
    this.syncExternalTabAuth(info, hasBundledDescriptor);
    this.notify();
  };

  syncPluginThemeFrame(frame: HTMLIFrameElement | null) {
    if (frame === this.pluginThemeFrame) {
      return;
    }
    this.releasePluginTheme?.();
    this.pluginThemeFrame = frame;
    this.releasePluginTheme = frame ? registerWidgetThemeFrame(frame, "*") : null;
  }

  readonly handlePluginThemeLoad = (event: Event) => {
    const frame = event.currentTarget;
    if (!(frame instanceof HTMLIFrameElement) || frame !== this.pluginThemeFrame) {
      return;
    }
    postWidgetTheme(frame);
  };

  private readonly handlePluginSessionOpen = (event: MessageEvent<unknown>) => {
    const context = this.context;
    const descriptor = this.tabInfo();
    if (
      this.disposed ||
      !context ||
      this.gatewaySource !== context.gateway ||
      this.gatewayClient !== context.gateway.snapshot.client ||
      this.gatewayHello !== context.gateway.snapshot.hello ||
      this.gatewayConnectionRevision !== context.gateway.connectionRevision ||
      this.externalAuthTargetKey !== this.externalTabAuthKey(descriptor, false)
    ) {
      return;
    }
    openPluginFrameSession(event, {
      context,
      element: this.host,
      frame: this.pluginThemeFrame,
      descriptor,
      authenticated:
        this.externalAuthReadyKey !== null &&
        this.externalAuthReadyKey === this.externalAuthTargetKey,
      authenticatedAt: this.externalAuthRefreshedAt,
    });
  };

  externalTabAuthKey(
    info: GatewayControlUiPluginTab | undefined,
    hasBundledDescriptor: boolean,
  ): string | null {
    // Secure cross-site cookies work on HTTPS and browser-trusted loopback.
    // Insecure LAN HTTP must not fall back to an ambient bearer substitute.
    return info?.path &&
      info.requiresGatewayAuth === true &&
      !hasBundledDescriptor &&
      window.isSecureContext
      ? `${this.tabKey()}\n${info.path}`
      : null;
  }

  private probeExternalTabAuth(path: string, signal: AbortSignal): Promise<boolean> {
    const url = new URL(path, window.location.href);
    if (url.origin !== window.location.origin) {
      return Promise.resolve(false);
    }
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    const nonce = Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("");
    url.searchParams.set(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY, nonce);
    url.searchParams.set(CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY, window.location.origin);

    return new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("sandbox", "allow-scripts");
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: boolean) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        window.removeEventListener("message", handleMessage);
        signal.removeEventListener("abort", handleAbort);
        frame.remove();
        resolve(result);
      };
      const handleMessage = (event: MessageEvent) => {
        if (
          event.source === frame.contentWindow &&
          event.data?.type === CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE &&
          event.data?.nonce === nonce
        ) {
          finish(true);
        }
      };
      const handleAbort = () => finish(false);
      window.addEventListener("message", handleMessage);
      signal.addEventListener("abort", handleAbort, { once: true });
      timeout = setTimeout(() => finish(false), EXTERNAL_AUTH_PROBE_TIMEOUT_MS);
      frame.src = url.toString();
      document.body.append(frame);
    });
  }

  private syncExternalTabAuth(
    info: GatewayControlUiPluginTab | undefined,
    hasBundledDescriptor: boolean,
  ) {
    const targetKey = this.externalTabAuthKey(info, hasBundledDescriptor);
    if (this.externalAuthTargetKey !== targetKey) {
      this.clearExternalTabAuth();
      this.externalAuthTargetKey = targetKey;
    }
    if (
      targetKey &&
      this.externalAuthReadyKey !== targetKey &&
      this.externalAuthUnavailableKey !== targetKey
    ) {
      this.refreshExternalTabAuth(targetKey);
    }
  }

  private refreshExternalTabAuth(targetKey: string) {
    const context = this.context;
    if (
      !context ||
      context.gateway.snapshot.phase !== "connected" ||
      this.externalAuthTargetKey !== targetKey ||
      this.externalAuthRefreshAbortController ||
      this.externalAuthProbeAbortController
    ) {
      return;
    }
    const refreshStartedAt = Date.now();
    const abortController = new AbortController();
    this.externalAuthUnavailableKey = null;
    this.notify();
    this.externalAuthRefreshAbortController = abortController;
    this.externalAuthRefreshWatchdog = setTimeout(() => {
      if (this.externalAuthRefreshAbortController === abortController) {
        this.requestExternalTabAuthRestart(targetKey);
      }
    }, EXTERNAL_AUTH_REFRESH_TIMEOUT_MS);
    const finish = () => {
      if (
        this.externalAuthRefreshAbortController !== abortController ||
        this.externalAuthTargetKey !== targetKey
      ) {
        return false;
      }
      if (this.finishExternalTabAuthRefreshAttempt(targetKey)) {
        this.refreshExternalTabAuth(targetKey);
        return false;
      }
      return true;
    };
    void context.config
      .refresh({ signal: abortController.signal })
      .then((refreshed) => {
        if (!finish()) {
          return;
        }
        const info = this.tabInfo();
        const path = info?.path;
        const granted =
          refreshed !== null &&
          info !== undefined &&
          path !== undefined &&
          refreshed.pluginFrameGrants.some((grant) => pluginFrameGrantCoversTab(grant, info));
        if (granted) {
          this.startExternalTabAuthProbe(targetKey, path, refreshStartedAt);
        } else if (refreshed) {
          this.externalAuthReadyKey = null;
          this.externalAuthUnavailableKey = targetKey;
          this.externalAuthRefreshedAt = 0;
          this.notify();
        } else {
          this.scheduleExternalTabAuthRefresh(targetKey, false);
        }
      })
      .catch(() => {
        if (finish()) {
          this.scheduleExternalTabAuthRefresh(targetKey, false);
        }
      });
  }

  private startExternalTabAuthProbe(targetKey: string, path: string, refreshedAt: number) {
    this.cancelExternalTabAuthProbe();
    const abortController = new AbortController();
    this.externalAuthProbeAbortController = abortController;
    let probeResult: Promise<boolean>;
    try {
      probeResult = this.probeExternalTabAuth(path, abortController.signal);
    } catch {
      probeResult = Promise.resolve(false);
    }
    void probeResult
      .catch(() => false)
      .then((available) => {
        if (
          this.externalAuthProbeAbortController !== abortController ||
          this.externalAuthTargetKey !== targetKey
        ) {
          return;
        }
        this.externalAuthProbeAbortController = null;
        if (available) {
          this.externalAuthReadyKey = targetKey;
          this.externalAuthRefreshedAt = refreshedAt;
          this.scheduleExternalTabAuthExpiry(targetKey, refreshedAt);
          this.scheduleExternalTabAuthRefresh(targetKey, true);
          this.notify();
          return;
        }
        this.externalAuthReadyKey = null;
        this.externalAuthUnavailableKey = targetKey;
        this.externalAuthRefreshedAt = 0;
        this.clearExternalTabAuthTimers();
        this.notify();
      });
  }

  private cancelExternalTabAuthProbe() {
    const abortController = this.externalAuthProbeAbortController;
    this.externalAuthProbeAbortController = null;
    abortController?.abort();
  }

  private finishExternalTabAuthRefreshAttempt(targetKey: string): boolean {
    const shouldRestart = this.externalAuthRestartKey === targetKey;
    if (this.externalAuthRefreshWatchdog) {
      clearTimeout(this.externalAuthRefreshWatchdog);
    }
    this.externalAuthRefreshWatchdog = null;
    this.externalAuthRefreshAbortController = null;
    this.externalAuthRestartKey = null;
    return shouldRestart;
  }

  private requestExternalTabAuthRestart(targetKey: string) {
    if (this.externalAuthTargetKey !== targetKey) {
      return;
    }
    if (this.externalAuthRefreshAbortController) {
      // Wait for abort settlement before starting the replacement request so a
      // stale response cannot overwrite its newer route cookie.
      this.externalAuthRestartKey = targetKey;
      this.externalAuthRefreshAbortController?.abort();
      return;
    }
    this.cancelExternalTabAuthProbe();
    this.refreshExternalTabAuth(targetKey);
  }

  private scheduleExternalTabAuthExpiry(targetKey: string, refreshedAt: number) {
    if (this.externalAuthExpiryTimer) {
      clearTimeout(this.externalAuthExpiryTimer);
    }
    const delay = Math.max(0, refreshedAt + CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS - Date.now());
    this.externalAuthExpiryTimer = setTimeout(() => {
      this.externalAuthExpiryTimer = null;
      if (this.externalAuthTargetKey !== targetKey || this.externalAuthReadyKey !== targetKey) {
        return;
      }
      // Cookie expiry is independent of renewal completion. Unmount the frame,
      // abandon any hung refresh, and obtain a fresh grant before remounting.
      this.externalAuthReadyKey = null;
      this.externalAuthRefreshedAt = 0;
      this.pluginFrameGeneration = {};
      this.clearExternalTabAuthTimers();
      this.requestExternalTabAuthRestart(targetKey);
      this.notify();
    }, delay);
  }

  private scheduleExternalTabAuthRefresh(targetKey: string, refreshed: boolean) {
    if (this.externalAuthRefreshTimer) {
      clearTimeout(this.externalAuthRefreshTimer);
    }
    const delay = refreshed ? CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2 : 5_000;
    this.externalAuthRefreshTimer = setTimeout(() => {
      this.externalAuthRefreshTimer = null;
      this.refreshExternalTabAuth(targetKey);
    }, delay);
  }

  private clearExternalTabAuthTimers() {
    clearTimeout(this.externalAuthRefreshTimer ?? undefined);
    clearTimeout(this.externalAuthExpiryTimer ?? undefined);
    this.externalAuthRefreshTimer = null;
    this.externalAuthExpiryTimer = null;
  }

  private clearExternalTabAuth() {
    this.pluginFrameGeneration = {};
    this.clearExternalTabAuthTimers();
    if (this.externalAuthRefreshWatchdog) {
      clearTimeout(this.externalAuthRefreshWatchdog);
    }
    this.externalAuthRefreshAbortController?.abort();
    this.cancelExternalTabAuthProbe();
    this.externalAuthRefreshWatchdog = null;
    this.externalAuthRefreshAbortController = null;
    this.externalAuthRestartKey = null;
    this.externalAuthTargetKey = null;
    this.externalAuthReadyKey = null;
    this.externalAuthUnavailableKey = null;
    this.externalAuthRefreshedAt = 0;
  }

  private resetExternalTabAuthForGatewayChange(targetKey: string, connected: boolean) {
    this.pluginFrameGeneration = {};
    this.clearExternalTabAuthTimers();
    this.externalAuthReadyKey = null;
    this.externalAuthUnavailableKey = null;
    this.externalAuthRefreshedAt = 0;
    this.externalAuthTargetKey = targetKey;
    this.cancelExternalTabAuthProbe();
    if (this.externalAuthRefreshAbortController) {
      this.externalAuthRestartKey = connected ? targetKey : null;
      this.externalAuthRefreshAbortController?.abort();
    } else if (connected) {
      this.refreshExternalTabAuth(targetKey);
    }
  }

  private stopBundledView() {
    this.replaceBundledViewHost();
    this.bundledViewState = { status: "idle" };
  }

  private replaceBundledViewHost() {
    if (this.bundledViewState.status === "ready") {
      this.bundledViewState.view.stop(this.bundledViewHost);
    }
    // Async controller work is keyed by host. A new host makes every completion
    // from the retired connection epoch unreachable without coupling plugins to the renderer.
    this.bundledViewHost = {};
  }

  private updateGatewaySource(gateway: ApplicationContext["gateway"]) {
    const { client, hello } = gateway.snapshot;
    const connected = gateway.snapshot.phase === "connected";
    if (
      this.gatewaySource === gateway &&
      this.gatewayClient === client &&
      this.gatewayHello === hello &&
      this.gatewayConnectionRevision === gateway.connectionRevision &&
      this.gatewayConnected === connected
    ) {
      return;
    }
    const externalAuthTargetKey = this.externalAuthTargetKey;
    this.replaceBundledViewHost();
    this.gatewaySource = gateway;
    this.gatewayClient = client;
    this.gatewayHello = hello;
    this.gatewayConnectionRevision = gateway.connectionRevision;
    this.gatewayConnected = connected;
    if (externalAuthTargetKey) {
      this.resetExternalTabAuthForGatewayChange(externalAuthTargetKey, connected);
    }
  }

  tabInfo(): GatewayControlUiPluginTab | undefined {
    const tabs = this.context?.gateway.snapshot.hello?.controlUiTabs ?? [];
    const tab = tabs.find(
      (entry) =>
        entry.pluginId === (this.props.pluginId ?? "") && entry.id === (this.props.tabId ?? ""),
    );
    const path = tab?.path && uiDevGatewayResourceUrl(tab.path);
    return tab && path && path !== tab.path ? { ...tab, path } : tab;
  }
}
