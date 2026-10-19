import { PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { isMcpAppViewExpiredError } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { raceWithTimeout } from "@openclaw/retry";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { navigateMcpAppLink } from "../app/mcp-app-routing.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { i18n, t as translate } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { parseMcpAppLink } from "../lib/mcp-app-route.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { listen } from "../lib/reactive/listener.ts";
import { OpenClawAppBridge, bindMcpAppResourceHandlers } from "./mcp-app-bridge.ts";
import { createMcpAppConfirm } from "./mcp-app-confirm.ts";
import {
  buildMcpAppFrameHostContext,
  loadMcpAppSandbox,
  waitForMcpAppHandlerRegistration,
  waitForMcpAppInitialization,
} from "./mcp-app-frame.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchMcpAppMessage,
  isWidgetFrameInteractable,
  negotiateMcpAppDisplayModes,
  MCP_APP_CONTEXT_EVENT,
  type McpAppContextState,
  type McpAppContextEventDetail,
  MCP_APP_VIEW_EXPIRED_EVENT,
} from "./mcp-app-security.ts";
import type {
  McpAppBinding,
  McpAppResources,
  McpAppViewElement,
  McpAppViewPayload,
  McpAppViewProps,
} from "./mcp-app-view-types.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

registerMcpAppEnglish();

const MCP_APP_TEARDOWN_TIMEOUT_MS = 250;

/** Owns synchronous frame/protocol admission; the view observes its publications. */
export function createMcpAppView(
  host: McpAppViewElement,
  context: ApplicationContext,
  afterSettlement: (callback: () => void) => void,
) {
  let inactive: "ended" | "reconstructed" | null = null;
  let errorState: unknown = null;
  let mountElement: HTMLDivElement | undefined;
  let activeResources: McpAppResources | null = null;
  let teardownPromise: Promise<void> | null = null;
  let setupAbort: AbortController | undefined;
  let requestAbort = new AbortController();
  const confirmation = createMcpAppConfirm();
  const listeners = new Set<() => void>();
  const publishState = () => listeners.forEach((listener) => listener());
  let started = false;
  let disposed = false;
  let retired = false;
  let inputFlushPending = false;
  let reconnectSetupPending = false;
  let stopConnection: (() => void) | undefined;
  let stopLocale: (() => void) | undefined;
  let bindingInputs: ReturnType<typeof readBindingInputs> | undefined;
  let presentationInputs:
    | readonly [number, boolean, McpAppViewProps["displayMode"], string | undefined]
    | undefined;
  let titleInput: string | undefined;
  let surfaceInput: McpAppViewProps["surface"] | undefined;

  function inputChanged() {
    if (!started || disposed || inputFlushPending) {
      return;
    }
    inputFlushPending = true;
    afterSettlement(flushInputs);
  }

  function readBindingInputs() {
    const gateway = context.gateway;
    return [
      gateway.snapshot.client,
      host.sessionKey,
      host.viewId,
      host.agentId,
      gateway.connectionRevision,
      gatewayPresentationScope(gateway).key,
      gateway.snapshot.phase === "connected" &&
        gateway.snapshot.hello !== null &&
        !hasOperatorReadAccess(gateway.snapshot.hello.auth ?? null),
    ] as const;
  }

  function flushInputs() {
    inputFlushPending = false;
    if (disposed) {
      return;
    }
    const nextBinding = readBindingInputs();
    const bindingChanged = !bindingInputs?.every((value, index) => value === nextBinding[index]);
    bindingInputs = nextBinding;
    const reconnectSetup = reconnectSetupPending && !retired;
    reconnectSetupPending = false;
    if (bindingChanged || reconnectSetup) {
      void setup(currentBinding(nextBinding));
    }
    if (titleInput !== host.title) {
      titleInput = host.title;
      updateTitle();
    }
    const nextPresentation = [
      host.height,
      host.fillContainer,
      host.displayMode,
      host.deepLink,
    ] as const;
    const presentationChanged = !presentationInputs?.every(
      (value, index) => value === nextPresentation[index],
    );
    presentationInputs = nextPresentation;
    if (presentationChanged) {
      updatePresentation();
    }
    if (surfaceInput !== host.surface && !presentationChanged) {
      updateReservedHeight();
    }
    surfaceInput = host.surface;
  }

  function start() {
    started = true;
    let { client, phase, hello } = context.gateway.snapshot;
    stopConnection = context.gateway.subscribe((snapshot) => {
      if (snapshot.client !== client || snapshot.phase !== phase || snapshot.hello !== hello) {
        connectionChanged();
      }
      ({ client, phase, hello } = snapshot);
      // Scope, generation, and access can change without replacing the snapshot's objects.
      inputChanged();
    });
    stopLocale = i18n.subscribe(updateTitle);
    inputChanged();
  }

  function dispose() {
    disposed = true;
    stopConnection?.();
    stopLocale?.();
    void teardown();
  }

  function setInactive(value: typeof inactive) {
    inactive = value;
    publishState();
  }
  function connectionChanged() {
    requestAbort.abort();
    requestAbort = new AbortController();
    confirmation.cancel();
    if (context.gateway.snapshot.phase === "connected") {
      const resources = activeResources;
      if (!resources && !retired) {
        setupAbort?.abort();
        reconnectSetupPending = true;
        inputChanged();
      } else if (resources?.reconnect) {
        const signal = requestAbort.signal;
        void resources.reconnect().then(
          () => {
            if (!signal.aborted && activeResources === resources && errorState) {
              errorState = null;
              publishState();
            }
          },
          (error: unknown) => {
            if (!signal.aborted && activeResources === resources) {
              errorState = error;
              publishState();
            }
          },
        );
      }
    }
  }
  async function setup(binding: McpAppBinding | null) {
    if (disposed) {
      return;
    }
    retired = false;
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
      promoteToPopoverTopLayer(host, () => [host]);
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
    const requestSignal = signal
      ? AbortSignal.any([signal, requestAbort.signal])
      : requestAbort.signal;
    try {
      requestSignal.throwIfAborted();
      const gateway = context.gateway;
      if (
        gateway.snapshot.phase !== "connected" ||
        gateway.snapshot.client !== binding.client ||
        !hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null) ||
        gatewayPresentationScope(gateway).key !== binding.scope
      ) {
        throw new Error(translate("mcpApp.errors.gatewayUnavailable"));
      }
      const { agentId: _untrustedAgent, ...operationParams } = params;
      const requestParams = {
        ...operationParams,
        sessionKey: binding.sessionKey,
        viewId: binding.viewId,
        ...(binding.agentId ? { agentId: binding.agentId } : {}),
      };
      const result = await binding.client.request<T>(method, requestParams, {
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      return result;
    } catch (error) {
      if (
        isMcpAppViewExpiredError(error) &&
        !requestSignal.aborted &&
        host.viewId === binding.viewId &&
        host.sessionKey === binding.sessionKey &&
        context.gateway.snapshot.client === binding.client
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
      resources.requestAbort.abort();
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
    retired = true;
    bindingInputs = readBindingInputs();
    reconnectSetupPending = false;
    setupAbort?.abort();
    await teardownResources(activeResources);
  }

  /** Restarts a torn-down view only when its parent kept the element connected. */
  function restartAfterTeardown() {
    if (!host.isConnected || activeResources || teardownPromise) {
      return;
    }
    requestAbort = new AbortController();
    void setup(currentBinding());
  }

  function currentBinding(inputs = readBindingInputs()): McpAppBinding | null {
    const [client, sessionKey, viewId, agentId, connectionRevision, scope, denied] = inputs;
    return client && !denied
      ? {
          client,
          sessionKey,
          viewId,
          agentId: agentId || undefined,
          connectionRevision,
          scope,
        }
      : null;
  }

  function isCurrentBinding(
    binding: McpAppBinding,
    resources: McpAppResources,
    signal: AbortSignal,
  ): boolean {
    const gateway = context.gateway;
    return (
      !signal.aborted &&
      !resources.disposed &&
      activeResources === resources &&
      host.isConnected &&
      inactive !== "ended" &&
      host.sessionKey === binding.sessionKey &&
      host.viewId === binding.viewId &&
      (host.agentId || undefined) === binding.agentId &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === binding.client &&
      hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null) &&
      gateway.connectionRevision === binding.connectionRevision &&
      gatewayPresentationScope(gateway).key === binding.scope
    );
  }

  function bindOpenLinkHandler(
    bridge: OpenClawAppBridge,
    binding: McpAppBinding,
    resources: McpAppResources,
    signal: AbortSignal,
  ) {
    bridge.onopenlink = ({ url }) => {
      // Both external and plugin navigation require the current, focused App.
      if (
        !isCurrentBinding(binding, resources, signal) ||
        !isWidgetFrameInteractable(resources.iframe)
      ) {
        return Promise.resolve({ isError: true });
      }
      if (!parseMcpAppLink(url)) {
        return Promise.resolve(openExternalUrlSafe(url) ? {} : { isError: true });
      }
      return Promise.resolve(navigateMcpAppLink(context, url) ? {} : { isError: true });
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
        requestAbort: new AbortController(),
        cleanups: new Set(),
        frameHeight: host.height,
        iframe,
        transport: null,
        disposed: false,
      };
      resources = createdResources;
      activeResources = createdResources;
      addResourceCleanup(createdResources, () => confirmation.cancel());
      addResourceCleanup(
        createdResources,
        listen(signal, "abort", () => void teardownResources(createdResources), { once: true }),
      );

      const addCleanup = (cleanup: () => void) => addResourceCleanup(createdResources, cleanup);
      await loadMcpAppSandbox(
        iframe,
        resolveSandboxHostUrl(
          payload.sandboxUrl,
          payload.sandboxPort,
          payload.sandboxOrigin,
          context.gateway.connection.gatewayUrl,
          window.location.origin,
          translate("mcpApp.errors.invalidSandboxUrl"),
        ),
        addCleanup,
      );
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
          ...buildMcpAppFrameHostContext(
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
      // Keep saves live through graceful teardown, then retire all frame RPCs.
      const request = <T = unknown>(method: string, params: Record<string, unknown>) =>
        requestOwner<T>(binding, method, params, createdResources.requestAbort.signal);
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
        const requestSignal = requestAbort.signal;
        const publish = (nextContext: McpAppContextState) => {
          if (
            createdResources.disposed ||
            requestSignal.aborted ||
            generation !== contextGeneration
          ) {
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
        return request<{ state: McpAppContextState }>("mcp.app.modelContext", {}).then(
          (response) => publish(response.state),
          () => undefined,
        );
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
      const notifications = bindMcpAppResourceHandlers({
        bridge,
        request,
        releaseResourceSubscription: (uri) =>
          requestOwner(binding, "mcp.app.unsubscribeResource", { uri }),
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
        subscribeEvents: (listener) => context.gateway.subscribeEvents(listener),
      });
      bridge.onrequestdisplaymode = ({ mode }) => {
        if ((mode !== "inline" && mode !== "fullscreen") || !modes.available.includes(mode)) {
          return Promise.resolve({ mode: host.displayMode });
        }
        host.displayMode = mode;
        iframe.style.height =
          mode === "fullscreen" || host.fillContainer
            ? "100%"
            : `${createdResources.frameHeight}px`;
        bridge.setHostContext(buildHostContext());
        return Promise.resolve({ mode });
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
      await waitForMcpAppInitialization(initialized, addCleanup);
      signal.throwIfAborted();
      const updateHostContext = () => bridge.setHostContext(buildHostContext());
      createdResources.updateHostContext = updateHostContext;
      updateHostContext();
      publishContext();
      notifications.start();
      createdResources.reconnect = async () => {
        await notifications.reconnect();
        if (payload.updateModelContextSupported === true) {
          await refreshModelContext();
        }
      };
      addResourceCleanup(createdResources, context.theme.subscribe(updateHostContext));
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
    start,
    dispose,
    inputChanged,
    setup,
    currentBinding,
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
