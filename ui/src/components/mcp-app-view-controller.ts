import {
  type AppBridge,
  McpUiHostContextSchema,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { isMcpAppViewExpiredError } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { raceWithTimeout } from "@openclaw/retry";
import type { ApplicationContext } from "../app/context.ts";
import { navigateMcpAppLink } from "../app/mcp-app-routing.ts";
import { t as translate } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { parseMcpAppLink } from "../lib/mcp-app-route.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import type { SolidBridgeElement } from "../lit/solid-bridge.ts";
import { OpenClawAppBridge, bindMcpAppResourceHandlers } from "./mcp-app-bridge.ts";
import { McpAppConfirm } from "./mcp-app-confirm.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchMcpAppMessage,
  isWidgetFrameInteractable,
  negotiateMcpAppDisplayModes,
  MCP_APP_CONTEXT_EVENT,
  type McpAppContextState,
  type McpAppContextEventDetail,
  MCP_APP_VIEW_EXPIRED_EVENT,
  type McpAppHostSandboxCsp,
} from "./mcp-app-security.ts";
import { collectMcpAppStyleVariables } from "./mcp-app-theme.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

registerMcpAppEnglish();

type McpAppViewPayload = {
  sandboxUrl: string;
  sandboxPort: number;
  sandboxOrigin?: string;
  html: string;
  csp?: McpAppHostSandboxCsp;
  toolInput: unknown;
  toolResult: Parameters<OpenClawAppBridge["sendToolResult"]>[0];
  messageSupported?: boolean;
  updateModelContextSupported?: boolean;
  richModelContextSupported?: boolean;
  fileResourcesSupported?: boolean;
  openFilesSupported?: boolean;
  hostContext?: { "openai/modelContext"?: McpAppContextState; "openai/deepLink"?: { url: string } };
  displayMode?: "inline" | "fullscreen";
  displayModes?: {
    availableDisplayModes?: Array<"inline" | "fullscreen">;
    preferredDisplayMode?: "inline" | "fullscreen";
  };
};

type HostContext = NonNullable<
  NonNullable<ConstructorParameters<typeof AppBridge>[3]>["hostContext"]
>;
type McpAppResources = {
  bridge: OpenClawAppBridge | null;
  cleanups: Set<() => void>;
  frameHeight: number;
  iframe: HTMLIFrameElement;
  transport: { close(): Promise<void> } | null;
  disposed: boolean;
  updateHostContext?: () => void;
};
type McpAppBinding = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  sessionKey: string;
  viewId: string;
  agentId?: string;
  connectionRevision: number | undefined;
  hello: ApplicationContext["gateway"]["snapshot"]["hello"] | undefined;
};

const MCP_APP_TEARDOWN_TIMEOUT_MS = 250;

async function waitForMcpAppHandlerRegistration(): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    }),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 1_000);
    }),
  ]);
}

function hostContext(
  element: Element | undefined,
  height: number,
  fillContainer: boolean,
  displayMode: "inline" | "fullscreen",
  availableDisplayModes: Array<"inline" | "fullscreen">,
): HostContext {
  const rect = element?.getBoundingClientRect();
  const touch = navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)").matches;
  const themeMode = document.documentElement.dataset.themeMode;
  // The SDK schema preserves optional style values while normalizing its complete key map.
  return McpUiHostContextSchema.parse({
    theme:
      themeMode === "light" || themeMode === "dark"
        ? themeMode
        : window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
    displayMode,
    availableDisplayModes,
    containerDimensions: {
      width: Math.max(1, Math.round(rect?.width || window.innerWidth)),
      height: fillContainer ? Math.max(0, Math.round(rect?.height ?? 0)) : height,
    },
    locale: navigator.language || undefined,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: touch && window.innerWidth < 768 ? "mobile" : "web",
    deviceCapabilities: {
      touch,
      hover: window.matchMedia?.("(hover: hover)").matches,
    },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    // Additive alongside `theme`: the string says which appearance is active,
    // these say what it actually resolves to. Republished by the same theme
    // subscription that re-sends this context.
    styles: { variables: collectMcpAppStyleVariables() },
  });
}

export type McpAppViewProps = {
  sessionKey: string;
  agentId: string;
  viewId: string;
  height: number;
  fillContainer: boolean;
  surface: "conversation" | "board";
  title: string;
  deepLink: string | undefined;
  onRelaunch: (() => void) | undefined;
  onHeightChange: ((height: number) => void) | undefined;
  relaunching: boolean;
  displayMode: "inline" | "fullscreen";
};
export type ViewMethods = { teardown(): Promise<void>; restartAfterTeardown(): void };
export type McpAppViewElement = SolidBridgeElement<McpAppViewProps, ViewMethods>;

/** Owns the live frame and protocol resources independently of rendering. */
export class McpAppViewController {
  private inactiveValue: "ended" | "reconstructed" | null = null;
  error: unknown = null;
  readonly confirmation = new McpAppConfirm(() => this.notify());
  mount: HTMLDivElement | undefined;
  private resources: McpAppResources | null = null;
  private teardownPromise: Promise<void> | null = null;
  private setupAbort: AbortController | undefined;

  constructor(
    readonly host: McpAppViewElement,
    readonly context: ApplicationContext,
    readonly notify: () => void,
  ) {}
  get inactive() {
    return this.inactiveValue;
  }
  set inactive(value: "ended" | "reconstructed" | null) {
    this.inactiveValue = value;
    this.notify();
  }
  get isConnected() {
    return this.host.isConnected;
  }
  get sessionKey() {
    return this.host.sessionKey;
  }
  get viewId() {
    return this.host.viewId;
  }
  get agentId() {
    return this.host.agentId;
  }
  get title() {
    return this.host.title;
  }
  get deepLink() {
    return this.host.deepLink;
  }
  get height() {
    return this.host.height;
  }
  get fillContainer() {
    return this.host.fillContainer;
  }
  get displayMode() {
    return this.host.displayMode;
  }
  set displayMode(value: "inline" | "fullscreen") {
    this.host.displayMode = value;
  }
  dispatchEvent(event: Event) {
    return this.host.dispatchEvent(event);
  }

  async setup(binding: McpAppBinding | null) {
    this.setupAbort?.abort();
    const abort = new AbortController();
    this.setupAbort = abort;
    this.error = null;
    this.notify();
    try {
      await this.teardownResources(this.resources);
      abort.signal.throwIfAborted();
      this.inactive = null;
      if (!this.sessionKey || !this.viewId) {
        return;
      }
      if (!binding) {
        throw new Error(translate("mcpApp.errors.gatewayUnavailable"));
      }
      await this.setupResources(binding, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.error = error;
        this.notify();
      }
    }
  }

  updateTitle() {
    if (this.resources) {
      this.resources.iframe.title = this.title || translate("mcpApp.title");
    }
  }

  updateReservedHeight() {
    if (this.mount) {
      this.mount.style.minHeight =
        this.host.surface === "conversation" && !this.fillContainer && this.displayMode === "inline"
          ? `${this.resources?.frameHeight ?? this.height}px`
          : "";
      if (this.host.onHeightChange) {
        this.host.style.minHeight = "";
      }
    }
  }

  updatePresentation() {
    this.confirmation.update();
    if (this.displayMode === "fullscreen") {
      promoteToPopoverTopLayer(this.host);
    } else {
      this.host.removeAttribute("popover");
    }
    if (this.resources) {
      this.resources.frameHeight = this.height;
      this.resources.iframe.style.height =
        this.fillContainer || this.displayMode === "fullscreen" ? "100%" : `${this.height}px`;
      this.resources.updateHostContext?.();
    }
    this.updateReservedHeight();
  }

  private async request<T = unknown>(
    binding: McpAppBinding,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      const { agentId: _untrustedAgent, ...operationParams } = params;
      const requestParams = {
        ...operationParams,
        sessionKey: binding.sessionKey,
        viewId: binding.viewId,
        ...(binding.agentId ? { agentId: binding.agentId } : {}),
      };
      return await (signal
        ? binding.client.request<T>(method, requestParams, { signal })
        : binding.client.request<T>(method, requestParams));
    } catch (error) {
      if (
        isMcpAppViewExpiredError(error) &&
        this.viewId === binding.viewId &&
        this.sessionKey === binding.sessionKey &&
        this.context?.gateway.snapshot.client === binding.client
      ) {
        this.inactive = "ended";
        this.confirmation.cancel();
        this.dispatchEvent(
          new CustomEvent(MCP_APP_VIEW_EXPIRED_EVENT, { bubbles: true, composed: true }),
        );
      }
      throw error;
    }
  }

  private addResourceCleanup(resources: McpAppResources, cleanup: () => void): () => void {
    resources.cleanups.add(cleanup);
    return () => {
      if (resources.cleanups.delete(cleanup)) {
        cleanup();
      }
    };
  }

  private async teardownResources(resources: McpAppResources | null | undefined) {
    if (!resources || resources.disposed) {
      await this.teardownPromise;
      return;
    }
    resources.disposed = true;
    if (this.resources === resources) {
      this.resources = null;
    }
    for (const cleanup of resources.cleanups) {
      resources.cleanups.delete(cleanup);
      cleanup();
    }
    const teardown = (async () => {
      if (resources.bridge) {
        await raceWithTimeout(
          resources.bridge.teardownResource({}).catch(() => undefined),
          MCP_APP_TEARDOWN_TIMEOUT_MS,
          () => undefined,
        );
      }
      await resources.transport?.close().catch(() => undefined);
      resources.iframe.remove();
    })();
    this.teardownPromise = teardown;
    try {
      await teardown;
    } finally {
      if (this.teardownPromise === teardown) {
        this.teardownPromise = null;
      }
    }
  }

  /** Parent render owners await this before removing the connected view. */
  async teardown() {
    this.setupAbort?.abort();
    await this.teardownResources(this.resources);
  }

  /** Restarts a torn-down view only when its parent kept the element connected. */
  restartAfterTeardown() {
    if (!this.isConnected || this.resources || this.teardownPromise) {
      return;
    }
    void this.setup(this.binding());
  }

  binding(): McpAppBinding | null {
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.client;
    return client
      ? {
          client,
          sessionKey: this.sessionKey,
          viewId: this.viewId,
          agentId: this.agentId || undefined,
          connectionRevision: gateway.connectionRevision,
          hello: gateway.snapshot.hello,
        }
      : null;
  }

  private isCurrentBinding(
    binding: McpAppBinding,
    resources: McpAppResources,
    signal: AbortSignal,
  ): boolean {
    const gateway = this.context?.gateway;
    return (
      !signal.aborted &&
      !resources.disposed &&
      this.resources === resources &&
      this.isConnected &&
      this.inactive !== "ended" &&
      this.sessionKey === binding.sessionKey &&
      this.viewId === binding.viewId &&
      (this.agentId || undefined) === binding.agentId &&
      gateway?.snapshot.phase === "connected" &&
      gateway.snapshot.client === binding.client &&
      gateway.connectionRevision === binding.connectionRevision &&
      gateway.snapshot.hello === binding.hello
    );
  }

  private bindOpenLinkHandler(
    bridge: OpenClawAppBridge,
    binding: McpAppBinding,
    resources: McpAppResources,
    signal: AbortSignal,
  ) {
    bridge.onopenlink = async ({ url }) => {
      if (!parseMcpAppLink(url)) {
        return openExternalUrlSafe(url) ? {} : { isError: true };
      }
      const context = this.context;
      // Recognized plugin links navigate this host, so a retired/background frame
      // must not redirect a collaborator or a replacement connection.
      if (
        !context ||
        !this.isCurrentBinding(binding, resources, signal) ||
        !isWidgetFrameInteractable(resources.iframe)
      ) {
        return { isError: true };
      }
      return navigateMcpAppLink(context, url) ? {} : { isError: true };
    };
  }

  private async setupResources(
    binding: McpAppBinding,
    signal: AbortSignal,
  ): Promise<McpAppResources> {
    const { sessionKey, viewId, agentId } = binding;
    let resources: McpAppResources | null = null;
    try {
      const payload = await this.request<McpAppViewPayload>(binding, "mcp.app.view", {}, signal);
      const mount = this.mount;
      signal.throwIfAborted();
      this.inactive = payload.messageSupported === false ? "reconstructed" : null;
      if (!mount) {
        throw new Error(translate("mcpApp.errors.mountUnavailable"));
      }
      const iframe = document.createElement("iframe");
      iframe.title = this.title || translate("mcpApp.title");
      // The isolated proxy binds its parent before accepting messages. Only the
      // Control UI origin is disclosed; path/query data remains suppressed.
      iframe.referrerPolicy = "origin";
      iframe.style.height = this.fillContainer ? "100%" : `${this.height}px`;
      // The proxy listener is a dedicated origin that never serves host data,
      // so Apps retain their required origin capabilities without reaching Control UI.
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      mount.appendChild(iframe);
      const createdResources: McpAppResources = {
        bridge: null,
        cleanups: new Set(),
        frameHeight: this.height,
        iframe,
        transport: null,
        disposed: false,
      };
      resources = createdResources;
      this.resources = createdResources;
      this.addResourceCleanup(createdResources, () => this.confirmation.cancel());
      signal.addEventListener("abort", () => void this.teardownResources(createdResources), {
        once: true,
      });

      const proxyReady = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanupProxyReady();
          reject(new Error(translate("mcpApp.errors.sandboxTimedOut")));
        }, 15_000);
        const onMessage = (event: MessageEvent) => {
          if (
            event.source === iframe.contentWindow &&
            event.data?.method === "ui/notifications/sandbox-proxy-ready"
          ) {
            cleanupProxyReady();
            resolve();
          }
        };
        const cleanupProxyReady = this.addResourceCleanup(createdResources, () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
        });
        window.addEventListener("message", onMessage);
      });
      iframe.src = resolveSandboxHostUrl(
        payload.sandboxUrl,
        payload.sandboxPort,
        payload.sandboxOrigin,
        this.context?.gateway.connection.gatewayUrl ?? "",
        window.location.origin,
        translate("mcpApp.errors.invalidSandboxUrl"),
      );
      await proxyReady;
      signal.throwIfAborted();
      if (!iframe.contentWindow) {
        throw new Error(translate("mcpApp.errors.sandboxUnavailable"));
      }

      let modes = negotiateMcpAppDisplayModes(payload.displayModes);
      this.displayMode =
        payload.displayMode && modes.available.includes(payload.displayMode)
          ? payload.displayMode
          : modes.initial;
      let modelContext = payload.hostContext?.["openai/modelContext"] ?? null;
      let contextGeneration = 0;
      const buildHostContext = () => {
        const deepLink = this.deepLink
          ? { url: this.deepLink }
          : payload.hostContext?.["openai/deepLink"];
        if (
          deepLink &&
          (!deepLink.url.startsWith("/") ||
            deepLink.url.startsWith("//") ||
            deepLink.url.includes("#"))
        ) {
          throw new Error("Invalid App deep link");
        }
        return {
          ...hostContext(
            mount,
            createdResources.frameHeight,
            this.fillContainer || this.displayMode === "fullscreen",
            this.displayMode,
            modes.available,
          ),
          "openai/modelContext": modelContext,
          ...(deepLink ? { "openai/deepLink": deepLink } : {}),
        };
      };
      const publishContext = () =>
        this.dispatchEvent(
          new CustomEvent<McpAppContextEventDetail>(MCP_APP_CONTEXT_EVENT, {
            bubbles: true,
            composed: true,
            detail: { sessionKey, viewId, state: modelContext },
          }),
        );
      const bridge = new OpenClawAppBridge(
        null,
        { name: "OpenClaw", version: "1.0.0" },
        buildMcpAppHostCapabilities(
          payload.csp,
          payload.messageSupported === true,
          payload.updateModelContextSupported === true,
          {
            richModelContext: payload.richModelContextSupported === true,
            fileResources: payload.fileResourcesSupported === true,
            openFiles: payload.openFilesSupported === true,
          },
        ),
        { hostContext: buildHostContext() },
      );
      createdResources.bridge = bridge;
      const request = <T = unknown>(method: string, params: Record<string, unknown>) =>
        this.request<T>(binding, method, params);
      const isCurrent = () => this.isCurrentBinding(binding, createdResources, signal);
      const confirm = (text: string, kind: "message" | "file") =>
        this.confirmation.request({
          frame: iframe,
          title: this.title || translate("mcpApp.title"),
          text,
          kind,
          isCurrent,
        });
      const refreshModelContext = (clearedUpdateId?: string) => {
        if (clearedUpdateId && modelContext && modelContext.updateId !== clearedUpdateId) {
          return undefined;
        }
        const generation = ++contextGeneration;
        const publish = (nextContext: McpAppContextState) => {
          if (createdResources.disposed || generation !== contextGeneration) {
            return;
          }
          modelContext = nextContext;
          bridge.setHostContext(buildHostContext());
          publishContext();
        };
        if (clearedUpdateId) {
          publish(null);
          return undefined;
        }
        return request<{ state: McpAppContextState }>("mcp.app.modelContext", {})
          .then((response) => response.state)
          .catch(() => null)
          .then(publish);
      };
      const handleRequestTeardown = () => {
        void this.teardown();
      };
      bridge.onrequestteardown = handleRequestTeardown;
      this.addResourceCleanup(createdResources, () => {
        if (bridge.onrequestteardown === handleRequestTeardown) {
          bridge.onrequestteardown = undefined;
        }
      });
      if (payload.messageSupported === true) {
        bridge.setMessageHandler(async (params) => {
          const accepted = await dispatchMcpAppMessage(
            iframe,
            { sessionKey, viewId },
            params,
            (prompt) => confirm(prompt, "message"),
            isCurrent,
          );
          return accepted ? {} : { isError: true };
        });
      }
      if (payload.updateModelContextSupported === true) {
        bridge.setUpdateModelContextHandler(async (params) => {
          const result = await request<{ _meta?: Record<string, unknown> }>(
            "mcp.app.updateModelContext",
            { ...params },
          );
          await refreshModelContext();
          return result;
        });
      }
      const startNotifications = bindMcpAppResourceHandlers({
        bridge,
        request,
        sessionKey,
        viewId,
        iframe,
        agentId,
        fileResourcesSupported: payload.fileResourcesSupported,
        openFilesSupported: payload.openFilesSupported,
        confirmOpenFile: (path) => confirm(path, "file"),
        isDisposed: () => !isCurrent(),
        addCleanup: (cleanup) => {
          this.addResourceCleanup(createdResources, cleanup);
        },
        dispatchEvent: (event) => this.dispatchEvent(event),
        onModelContextChanged: (clearedUpdateId) => {
          void refreshModelContext(clearedUpdateId)?.catch(() => undefined);
        },
        onConversationInputRequested: () => {
          this.displayMode = "inline";
        },
        subscribeEvents: (listener) => this.context?.gateway.subscribeEvents?.(listener),
      });
      bridge.onrequestdisplaymode = async ({ mode }) => {
        if ((mode !== "inline" && mode !== "fullscreen") || !modes.available.includes(mode)) {
          return { mode: this.displayMode };
        }
        this.displayMode = mode;
        iframe.style.height =
          mode === "fullscreen" || this.fillContainer
            ? "100%"
            : `${createdResources.frameHeight}px`;
        bridge.setHostContext(buildHostContext());
        return { mode };
      };
      this.bindOpenLinkHandler(bridge, binding, createdResources, signal);
      bridge.onsizechange = ({ height }) => {
        if (
          height !== undefined &&
          Number.isFinite(height) &&
          isCurrent() &&
          !this.fillContainer &&
          this.displayMode !== "fullscreen"
        ) {
          const nextHeight = Math.min(1200, Math.max(160, Math.round(height)));
          createdResources.frameHeight = nextHeight;
          iframe.style.height = `${nextHeight}px`;
          this.updateReservedHeight();
          this.host.onHeightChange?.(nextHeight);
          bridge.setHostContext(buildHostContext());
        }
      };
      const initialized = new Promise<void>((resolve) => {
        bridge.oninitialized = () => {
          modes = negotiateMcpAppDisplayModes(
            payload.displayModes,
            bridge.getAppCapabilities()?.availableDisplayModes,
          );
          this.displayMode =
            payload.displayMode && modes.available.includes(payload.displayMode)
              ? payload.displayMode
              : modes.initial;
          resolve();
        };
      });
      const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
      createdResources.transport = transport;
      await bridge.connect(transport);
      signal.throwIfAborted();
      await bridge.sendSandboxResourceReady({
        html: payload.html,
        csp: payload.csp,
      });
      let initializationTimeout: number | undefined;
      const cleanupInitializationTimeout = this.addResourceCleanup(createdResources, () => {
        if (initializationTimeout !== undefined) {
          window.clearTimeout(initializationTimeout);
        }
      });
      try {
        await Promise.race([
          initialized,
          new Promise<never>((_, reject) => {
            initializationTimeout = window.setTimeout(
              () => reject(new Error(translate("mcpApp.errors.initializationTimedOut"))),
              15_000,
            );
          }),
        ]);
      } finally {
        cleanupInitializationTimeout();
      }
      signal.throwIfAborted();
      const updateHostContext = () => bridge.setHostContext(buildHostContext());
      createdResources.updateHostContext = updateHostContext;
      updateHostContext();
      publishContext();
      startNotifications();
      const hostContextCleanup = this.context?.theme.subscribe(updateHostContext);
      if (hostContextCleanup) {
        this.addResourceCleanup(createdResources, hostContextCleanup);
      }
      if (typeof ResizeObserver !== "undefined") {
        const hostResizeObserver = new ResizeObserver(updateHostContext);
        hostResizeObserver.observe(mount);
        this.addResourceCleanup(createdResources, () => hostResizeObserver.disconnect());
      }
      await waitForMcpAppHandlerRegistration();
      signal.throwIfAborted();
      await bridge.sendToolInput({
        arguments: asOptionalRecord(payload.toolInput) ?? {},
      });
      await bridge.sendToolResult(payload.toolResult);
      signal.throwIfAborted();
      return createdResources;
    } catch (error) {
      await this.teardownResources(resources);
      throw error;
    }
  }
}
