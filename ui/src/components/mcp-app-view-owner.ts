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
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";
import { OpenClawAppBridge, bindMcpAppResourceHandlers } from "./mcp-app-bridge.ts";
import { createMcpAppConfirm } from "./mcp-app-confirm.ts";
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

/** Owns synchronous frame/protocol admission; the view observes its publications. */
export function createMcpAppView(host: McpAppViewElement, context: ApplicationContext) {
  let inactive: "ended" | "reconstructed" | null = null;
  let errorState: unknown = null;
  let mountElement: HTMLDivElement | undefined;
  let activeResources: McpAppResources | null = null;
  let teardownPromise: Promise<void> | null = null;
  let setupAbort: AbortController | undefined;
  const confirmation = createMcpAppConfirm();
  const listeners = new Set<() => void>();
  const publishState = () => listeners.forEach((listener) => listener());
  function setInactive(value: typeof inactive) {
    inactive = value;
    publishState();
  }
  async function setup(binding: McpAppBinding | null) {
    setupAbort?.abort();
    const abort = new AbortController();
    setupAbort = abort;
    errorState = null;
    publishState();
    try {
      await teardownResources(activeResources);
      abort.signal.throwIfAborted();
      setInactive(null);
      if (!host.sessionKey || !host.viewId) {
        return;
      }
      if (!binding) {
        throw new Error(translate("mcpApp.errors.gatewayUnavailable"));
      }
      await setupResources(binding, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        errorState = error;
        publishState();
      }
    }
  }

  function updateTitle() {
    if (activeResources) {
      activeResources.iframe.title = host.title || translate("mcpApp.title");
    }
  }

  function updateReservedHeight() {
    if (mountElement) {
      mountElement.style.minHeight =
        host.surface === "conversation" && !host.fillContainer && host.displayMode === "inline"
          ? `${activeResources?.frameHeight ?? host.height}px`
          : "";
      if (host.onHeightChange) {
        host.style.minHeight = "";
      }
    }
  }

  function updatePresentation() {
    confirmation.update();
    if (host.displayMode === "fullscreen") {
      promoteToPopoverTopLayer(host);
    } else {
      host.removeAttribute("popover");
    }
    if (activeResources) {
      activeResources.frameHeight = host.height;
      activeResources.iframe.style.height =
        host.fillContainer || host.displayMode === "fullscreen" ? "100%" : `${host.height}px`;
      activeResources.updateHostContext?.();
    }
    updateReservedHeight();
  }

  async function requestOwner<T = unknown>(
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
        host.viewId === binding.viewId &&
        host.sessionKey === binding.sessionKey &&
        context?.gateway.snapshot.client === binding.client
      ) {
        setInactive("ended");
        confirmation.cancel();
        host.dispatchEvent(
          new CustomEvent(MCP_APP_VIEW_EXPIRED_EVENT, { bubbles: true, composed: true }),
        );
      }
      throw error;
    }
  }

  function addResourceCleanup(resources: McpAppResources, cleanup: () => void): () => void {
    resources.cleanups.add(cleanup);
    return () => {
      if (resources.cleanups.delete(cleanup)) {
        cleanup();
      }
    };
  }

  async function teardownResources(resources: McpAppResources | null | undefined) {
    if (!resources || resources.disposed) {
      await teardownPromise;
      return;
    }
    resources.disposed = true;
    if (activeResources === resources) {
      activeResources = null;
    }
    for (const cleanup of resources.cleanups) {
      resources.cleanups.delete(cleanup);
      cleanup();
    }
    const teardownWork = (async () => {
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
    teardownPromise = teardownWork;
    try {
      await teardownWork;
    } finally {
      if (teardownPromise === teardownWork) {
        teardownPromise = null;
      }
    }
  }

  /** Parent render owners await this before removing the connected view. */
  async function teardown() {
    setupAbort?.abort();
    await teardownResources(activeResources);
  }

  /** Restarts a torn-down view only when its parent kept the element connected. */
  function restartAfterTeardown() {
    if (!host.isConnected || activeResources || teardownPromise) {
      return;
    }
    void setup(currentBinding());
  }

  function currentBinding(): McpAppBinding | null {
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    return client
      ? {
          client,
          sessionKey: host.sessionKey,
          viewId: host.viewId,
          agentId: host.agentId || undefined,
          connectionRevision: gateway.connectionRevision,
          hello: gateway.snapshot.hello,
        }
      : null;
  }

  function isCurrentBinding(
    binding: McpAppBinding,
    resources: McpAppResources,
    signal: AbortSignal,
  ): boolean {
    const gateway = context?.gateway;
    return (
      !signal.aborted &&
      !resources.disposed &&
      activeResources === resources &&
      host.isConnected &&
      inactive !== "ended" &&
      host.sessionKey === binding.sessionKey &&
      host.viewId === binding.viewId &&
      (host.agentId || undefined) === binding.agentId &&
      gateway?.snapshot.phase === "connected" &&
      gateway.snapshot.client === binding.client &&
      gateway.connectionRevision === binding.connectionRevision &&
      gateway.snapshot.hello === binding.hello
    );
  }

  function bindOpenLinkHandler(
    bridge: OpenClawAppBridge,
    binding: McpAppBinding,
    resources: McpAppResources,
    signal: AbortSignal,
  ) {
    bridge.onopenlink = async ({ url }) => {
      // Both external and plugin navigation require the current, focused App.
      if (
        !context ||
        !isCurrentBinding(binding, resources, signal) ||
        !isWidgetFrameInteractable(resources.iframe)
      ) {
        return { isError: true };
      }
      if (!parseMcpAppLink(url)) {
        return openExternalUrlSafe(url) ? {} : { isError: true };
      }
      return navigateMcpAppLink(context, url) ? {} : { isError: true };
    };
  }

  async function setupResources(
    binding: McpAppBinding,
    signal: AbortSignal,
  ): Promise<McpAppResources> {
    const { sessionKey, viewId, agentId } = binding;
    let resources: McpAppResources | null = null;
    try {
      const payload = await requestOwner<McpAppViewPayload>(binding, "mcp.app.view", {}, signal);
      const mount = mountElement;
      signal.throwIfAborted();
      setInactive(payload.messageSupported === false ? "reconstructed" : null);
      if (!mount) {
        throw new Error(translate("mcpApp.errors.mountUnavailable"));
      }
      const iframe = document.createElement("iframe");
      iframe.title = host.title || translate("mcpApp.title");
      // The isolated proxy binds its parent before accepting messages. Only the
      // Control UI origin is disclosed; path/query data remains suppressed.
      iframe.referrerPolicy = "origin";
      iframe.style.height = host.fillContainer ? "100%" : `${host.height}px`;
      // The proxy listener is a dedicated origin that never serves host data,
      // so Apps retain their required origin capabilities without reaching Control UI.
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      mount.appendChild(iframe);
      const createdResources: McpAppResources = {
        bridge: null,
        cleanups: new Set(),
        frameHeight: host.height,
        iframe,
        transport: null,
        disposed: false,
      };
      resources = createdResources;
      activeResources = createdResources;
      addResourceCleanup(createdResources, () => confirmation.cancel());
      signal.addEventListener("abort", () => void teardownResources(createdResources), {
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
        const cleanupProxyReady = addResourceCleanup(createdResources, () => {
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
        });
        window.addEventListener("message", onMessage);
      });
      iframe.src = resolveSandboxHostUrl(
        payload.sandboxUrl,
        payload.sandboxPort,
        payload.sandboxOrigin,
        context?.gateway.connection.gatewayUrl ?? "",
        window.location.origin,
        translate("mcpApp.errors.invalidSandboxUrl"),
      );
      await proxyReady;
      signal.throwIfAborted();
      if (!iframe.contentWindow) {
        throw new Error(translate("mcpApp.errors.sandboxUnavailable"));
      }

      let modes = negotiateMcpAppDisplayModes(payload.displayModes);
      host.displayMode =
        payload.displayMode && modes.available.includes(payload.displayMode)
          ? payload.displayMode
          : modes.initial;
      let modelContext = payload.hostContext?.["openai/modelContext"] ?? null;
      let contextGeneration = 0;
      const buildHostContext = () => {
        const deepLink = host.deepLink
          ? { url: host.deepLink }
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
            host.fillContainer || host.displayMode === "fullscreen",
            host.displayMode,
            modes.available,
          ),
          "openai/modelContext": modelContext,
          ...(deepLink ? { "openai/deepLink": deepLink } : {}),
        };
      };
      const publishContext = () =>
        host.dispatchEvent(
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
        requestOwner<T>(binding, method, params);
      const isCurrent = () => isCurrentBinding(binding, createdResources, signal);
      const confirm = (text: string, kind: "message" | "file") =>
        confirmation.request({
          frame: iframe,
          title: host.title || translate("mcpApp.title"),
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
        void teardown();
      };
      bridge.onrequestteardown = handleRequestTeardown;
      addResourceCleanup(createdResources, () => {
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
          addResourceCleanup(createdResources, cleanup);
        },
        dispatchEvent: (event) => host.dispatchEvent(event),
        onModelContextChanged: (clearedUpdateId) => {
          void refreshModelContext(clearedUpdateId)?.catch(() => undefined);
        },
        onConversationInputRequested: () => {
          host.displayMode = "inline";
        },
        subscribeEvents: (listener) => context?.gateway.subscribeEvents?.(listener),
      });
      bridge.onrequestdisplaymode = async ({ mode }) => {
        if ((mode !== "inline" && mode !== "fullscreen") || !modes.available.includes(mode)) {
          return { mode: host.displayMode };
        }
        host.displayMode = mode;
        iframe.style.height =
          mode === "fullscreen" || host.fillContainer
            ? "100%"
            : `${createdResources.frameHeight}px`;
        bridge.setHostContext(buildHostContext());
        return { mode };
      };
      bindOpenLinkHandler(bridge, binding, createdResources, signal);
      bridge.onsizechange = ({ height }) => {
        if (
          height !== undefined &&
          Number.isFinite(height) &&
          isCurrent() &&
          !host.fillContainer &&
          host.displayMode !== "fullscreen"
        ) {
          const nextHeight = Math.min(1200, Math.max(160, Math.round(height)));
          createdResources.frameHeight = nextHeight;
          iframe.style.height = `${nextHeight}px`;
          updateReservedHeight();
          host.onHeightChange?.(nextHeight);
          bridge.setHostContext(buildHostContext());
        }
      };
      const initialized = new Promise<void>((resolve) => {
        bridge.oninitialized = () => {
          modes = negotiateMcpAppDisplayModes(
            payload.displayModes,
            bridge.getAppCapabilities()?.availableDisplayModes,
          );
          host.displayMode =
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
      const cleanupInitializationTimeout = addResourceCleanup(createdResources, () => {
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
      const hostContextCleanup = context?.theme.subscribe(updateHostContext);
      if (hostContextCleanup) {
        addResourceCleanup(createdResources, hostContextCleanup);
      }
      if (typeof ResizeObserver !== "undefined") {
        const hostResizeObserver = new ResizeObserver(updateHostContext);
        hostResizeObserver.observe(mount);
        addResourceCleanup(createdResources, () => hostResizeObserver.disconnect());
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
      await teardownResources(resources);
      throw error;
    }
  }
  return {
    confirmation,
    setup,
    currentBinding,
    updateTitle,
    updatePresentation,
    updateReservedHeight,
    teardown,
    restartAfterTeardown,
    read: () => ({ inactive, error: errorState }),
    setMount: (element: HTMLDivElement) => {
      mountElement = element;
    },
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
  };
}
export type McpAppViewOwner = ReturnType<typeof createMcpAppView>;
