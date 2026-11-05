import { PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { isMcpAppViewExpiredError } from "@openclaw/gateway-protocol/gateway-error-details";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { raceWithTimeout } from "@openclaw/retry";
import type { ApplicationContext } from "../app/context.ts";
import { navigateMcpAppLink } from "../app/mcp-app-routing.ts";
import { i18n, t as translate } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { parseMcpAppLink } from "../lib/mcp-app-route.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { observeResize } from "../lib/reactive/observers.ts";
import { boardAppDisplaySchema } from "../pages/chat/session-board-app-snapshot.ts";
import { bindMcpAppResourceHandlers } from "./mcp-app-bridge.ts";
import { createMcpAppConfirm } from "./mcp-app-confirm.ts";
import {
  buildMcpAppFrameHostContext,
  createMcpAppFrameBridge,
  loadMcpAppSandbox,
  waitForMcpAppHandlerRegistration,
  waitForMcpAppInitialization,
} from "./mcp-app-frame.ts";
import {
  dispatchMcpAppMessage,
  isWidgetFrameInteractable,
  negotiateMcpAppDisplayModes,
  MCP_APP_CONTEXT_EVENT,
  type McpAppContextState,
  type McpAppContextEventDetail,
  MCP_APP_VIEW_EXPIRED_EVENT,
} from "./mcp-app-security.ts";
import {
  requestMcpAppBinding,
  resolveMcpAppBinding,
  isCurrentMcpAppBinding,
  readMcpAppBindingInputs,
} from "./mcp-app-view-binding.ts";
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
  publishState: () => void,
) {
  let inactive: "ended" | "reconstructed" | null = null;
  let errorState: unknown = null;
  let mountElement: HTMLDivElement | undefined;
  let activeResources: McpAppResources | null = null;
  let teardownPromise: Promise<void> | null = null;
  let setupAbort: AbortController | undefined;
  let frameSetup = Promise.resolve();
  let requestAbort = new AbortController();
  const confirmation = createMcpAppConfirm();
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

  const readBindingInputs = () => readMcpAppBindingInputs(host, context.gateway);

  function flushInputs() {
    inputFlushPending = false;
    if (disposed) {
      return;
    }
    const nextBinding = readBindingInputs();
    const bindingChanged = !bindingInputs?.every((value, index) => value === nextBinding[index]);
    const retain =
      bindingInputs &&
      [1, 3, 5, 6, 7].every((index) => bindingInputs?.[index] === nextBinding[index]);
    bindingInputs = nextBinding;
    const reconnectSetup = reconnectSetupPending && !retired;
    reconnectSetupPending = false;
    if (bindingChanged || reconnectSetup) {
      void setup(currentBinding(nextBinding), retain);
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
    // Connection receipts retire frame requests before a replacement binding is admitted.
    stopConnection = context.gateway.subscribe((snapshot) => {
      if (snapshot.client !== client || snapshot.phase !== phase || snapshot.hello !== hello) {
        connectionChanged();
      }
      ({ client, phase, hello } = snapshot);
      // Scope, generation, and access can change without replacing the snapshot's objects.
      inputChanged();
    });
    // The protocol owner updates the iframe's native title outside Solid rendering.
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
  async function setup(binding: McpAppBinding | null, retain = false) {
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
      if (!retain || activeResources?.binding) await teardownResources(activeResources);
      abort.signal.throwIfAborted();
      if (!binding && retain && activeResources) return;
      const livePayload = binding
        ? requestOwner<McpAppViewPayload>(binding, "mcp.app.view", {}, abort.signal)
        : null;
      // Observe failures while the cached frame initializes; the result is awaited below.
      void livePayload?.catch(() => undefined);
      let displaySetup = activeResources ? frameSetup : undefined;
      if (!activeResources && !readBindingInputs()[6] && host.widget && host.appDisplay) {
        const cached = await host.appDisplay(host.widget);
        abort.signal.throwIfAborted();
        if (cached && host.sessionKey) {
          displaySetup = setupResources(null, cached);
          frameSetup = displaySetup;
          retain = true;
        }
      }
      if (!livePayload) {
        if (displaySetup) await displaySetup;
        else if (host.viewId) throw new Error(translate("mcpApp.errors.gatewayUnavailable"));
        return;
      }
      if (displaySetup) await displaySetup.catch(() => undefined);
      const payload = await livePayload;
      abort.signal.throwIfAborted();
      if (payload && binding && retain && (await activeResources?.adopt?.(binding, payload)))
        return;
      await teardownResources(activeResources);
      abort.signal.throwIfAborted();
      setInactive(null);
      if (!payload || !host.sessionKey) {
        if (host.viewId) throw new Error(translate("mcpApp.errors.gatewayUnavailable"));
        return;
      }
      frameSetup = setupResources(binding, payload);
      await frameSetup;
    } catch (error) {
      if (!abort.signal.aborted) {
        errorState = error;
        host.onHeightChange?.(null, true);
        updateReservedHeight();
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
        !errorState &&
        inactive !== "ended" &&
        host.surface === "conversation" &&
        !host.fillContainer &&
        host.displayMode === "inline"
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
    binding: McpAppBinding | null,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestSignal = signal
      ? AbortSignal.any([signal, requestAbort.signal])
      : requestAbort.signal;
    try {
      return await requestMcpAppBinding<T>(
        binding,
        context.gateway,
        method,
        params,
        requestSignal,
        translate("mcpApp.errors.gatewayUnavailable"),
      );
    } catch (error) {
      if (
        binding &&
        isMcpAppViewExpiredError(error) &&
        !requestSignal.aborted &&
        host.viewId === binding.viewId &&
        host.sessionKey === binding.sessionKey &&
        context.gateway.snapshot.client === binding.client
      ) {
        host.onHeightChange?.(null, true);
        setInactive("ended");
        updateReservedHeight();
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
    if (!retired || !host.isConnected || activeResources || teardownPromise) {
      return;
    }
    requestAbort = new AbortController();
    void setup(currentBinding());
  }

  function currentBinding(inputs = readBindingInputs()): McpAppBinding | null {
    return resolveMcpAppBinding(inputs, context.gateway.snapshot.phase === "connected");
  }

  async function setupResources(
    binding: McpAppBinding | null,
    payload: McpAppViewPayload,
  ): Promise<void> {
    const { widget, appDisplay } = host;
    let resources: McpAppResources | null = null;
    try {
      const mount = mountElement;
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
        binding,
        bridge: null,
        requestAbort: new AbortController(),
        cleanups: new Set(),
        frameHeight: host.height,
        iframe,
        transport: null,
        disposed: false,
      };
      const initialization = new AbortController();
      const signal = initialization.signal;
      addResourceCleanup(createdResources, () => initialization.abort());
      resources = createdResources;
      activeResources = createdResources;
      addResourceCleanup(createdResources, () => confirmation.cancel());

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

      let appReady = false;
      let modes = negotiateMcpAppDisplayModes(payload.displayModes);
      const initialDisplayMode = () =>
        payload.displayMode && modes.available.includes(payload.displayMode)
          ? payload.displayMode
          : modes.initial;
      host.displayMode = initialDisplayMode();
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
      const publishContext = () => {
        const live = createdResources.binding;
        if (!live) return;
        const { sessionKey, viewId } = live;
        host.dispatchEvent(
          new CustomEvent<McpAppContextEventDetail>(MCP_APP_CONTEXT_EVENT, {
            bubbles: true,
            composed: true,
            detail: { sessionKey, viewId, state: modelContext },
          }),
        );
      };
      const bridge = createMcpAppFrameBridge(payload, buildHostContext());
      createdResources.bridge = bridge;
      // Keep saves live through graceful teardown, then retire all frame RPCs.
      const liveBinding = () => {
        const current = createdResources.binding;
        if (!current) {
          throw new Error(translate("mcpApp.errors.gatewayUnavailable"));
        }
        return current;
      };
      const request = async <T = unknown>(method: string, params: Record<string, unknown>) =>
        requestOwner<T>(
          createdResources.binding,
          method,
          params,
          createdResources.requestAbort.signal,
        );
      const isCurrent = () =>
        !signal.aborted &&
        !createdResources.disposed &&
        activeResources === createdResources &&
        host.isConnected &&
        inactive !== "ended" &&
        isCurrentMcpAppBinding(createdResources.binding, host, context.gateway);
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
          const { sessionKey, viewId } = liveBinding();
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
          requestOwner(createdResources.binding, "mcp.app.unsubscribeResource", { uri }),
        binding: liveBinding,
        iframe,
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
      bridge.onrequestdisplaymode = async ({ mode }) => {
        liveBinding();
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
      bridge.onopenlink = async ({ url }) => {
        liveBinding();
        // Both external and plugin navigation require the current, focused App.
        if (!isCurrent() || !isWidgetFrameInteractable(createdResources.iframe)) {
          return Promise.resolve({ isError: true });
        }
        if (!parseMcpAppLink(url)) {
          return Promise.resolve(openExternalUrlSafe(url) ? {} : { isError: true });
        }
        return Promise.resolve(navigateMcpAppLink(context, url) ? {} : { isError: true });
      };
      bridge.onsizechange = ({ height }) => {
        if (
          height !== undefined &&
          Number.isFinite(height) &&
          isCurrent() &&
          !host.fillContainer &&
          host.displayMode !== "fullscreen"
        ) {
          const measured = Math.min(1200, Math.max(160, Math.round(height)));
          const nextHeight = host.onHeightChange?.(measured, appReady) ?? measured;
          createdResources.frameHeight = nextHeight;
          iframe.style.height = `${nextHeight}px`;
          updateReservedHeight();
          bridge.setHostContext(buildHostContext());
        }
      };
      const initialized = new Promise<void>((resolve) => {
        bridge.oninitialized = () => {
          appReady = true;
          modes = negotiateMcpAppDisplayModes(
            payload.displayModes,
            bridge.getAppCapabilities()?.availableDisplayModes,
          );
          host.displayMode = initialDisplayMode();
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
      if (binding) notifications.start();
      createdResources.reconnect = async () => {
        if (!createdResources.binding) return;
        await notifications.reconnect();
        if (payload.updateModelContextSupported === true) {
          await refreshModelContext();
        }
      };
      // Theme receipts update the remote app's host context through its live bridge.
      addResourceCleanup(createdResources, context.theme.subscribe(updateHostContext));
      if (typeof ResizeObserver !== "undefined") {
        addResourceCleanup(createdResources, observeResize([mount], updateHostContext));
      }
      await waitForMcpAppHandlerRegistration();
      signal.throwIfAborted();
      await bridge.sendToolInput({
        arguments: asOptionalRecord(payload.toolInput) ?? {},
      });
      await bridge.sendToolResult(payload.toolResult);
      signal.throwIfAborted();
      if (widget && isCurrent()) void appDisplay?.(widget, payload);
      if (!binding)
        createdResources.adopt = async (live, next) => {
          // Complete tool input is once per initialization; changed facts require a new frame.
          const { toolResult, ...initial } = boardAppDisplaySchema.parse(payload);
          const { toolResult: freshResult, ...fresh } = boardAppDisplaySchema.parse(next);
          if (JSON.stringify(initial) !== JSON.stringify(fresh)) return false;
          createdResources.binding = live;
          modelContext = next.hostContext?.["openai/modelContext"] ?? null;
          payload = next;
          createdResources.adopt = undefined;
          notifications.start();
          updateHostContext();
          publishContext();
          if (JSON.stringify(toolResult) !== JSON.stringify(freshResult))
            await bridge.sendToolResult(freshResult);
          if (widget && isCurrent()) void appDisplay?.(widget, next);
          return true;
        };
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
  };
}
export type McpAppViewOwner = ReturnType<typeof createMcpAppView>;
