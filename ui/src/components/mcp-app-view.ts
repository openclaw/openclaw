import { consume } from "@lit/context";
import { Task, TaskStatus } from "@lit/task";
import {
  type AppBridge,
  McpUiHostContextSchema,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { isMcpAppViewExpiredError } from "@openclaw/gateway-protocol";
import { raceWithTimeout } from "@openclaw/retry";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { navigateMcpAppLink } from "../app/mcp-app-routing.ts";
import { I18nController, t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { parseMcpAppLink } from "../lib/mcp-app-route.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
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
import { mcpAppViewStyles } from "./mcp-app-view-styles.ts";
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
  toolResult: unknown;
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

export class McpAppView extends LitElement {
  static override styles = mcpAppViewStyles;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "";
  @property({ attribute: false }) viewId = "";
  @property({ type: Number }) height = 600;
  @property({ type: Boolean, attribute: "fill-container", reflect: true }) fillContainer = false;
  @property({ attribute: false }) surface: "conversation" | "board" = "conversation";
  @property() override title = "";
  @property({ attribute: false }) deepLink: string | undefined;
  @property({ attribute: false }) onRelaunch: (() => void) | undefined;
  @property({ type: Boolean }) relaunching = false;
  @state() private inactive: "ended" | "reconstructed" | null = null;
  @property({ attribute: "display-mode", reflect: true }) displayMode: "inline" | "fullscreen" =
    "inline";
  protected readonly i18nController = new I18nController(this);
  private readonly mount = createRef<HTMLDivElement>();
  private readonly confirmation = new McpAppConfirm(() => this.requestUpdate());
  private resources: McpAppResources | null = null;
  private teardownPromise: Promise<void> | null = null;

  private readonly setupTask = new Task(this, {
    autoRun: "afterUpdate",
    args: () =>
      [
        this.context?.gateway.snapshot.client ?? null,
        this.sessionKey,
        this.viewId,
        this.agentId,
        this.context?.gateway.connectionRevision,
        this.context?.gateway.snapshot.hello,
      ] as const,
    task: async ([client, sessionKey, viewId, agentId, connectionRevision, hello], { signal }) => {
      await this.teardownResources(this.resources);
      this.inactive = null;
      if (!sessionKey || !viewId) {
        return null;
      }
      if (!client) {
        throw new Error(t("mcpApp.errors.gatewayUnavailable"));
      }
      return this.setupResources(
        { client, sessionKey, viewId, agentId: agentId || undefined, connectionRevision, hello },
        signal,
      );
    },
  });

  override disconnectedCallback() {
    void this.teardown();
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>) {
    this.confirmation.update();
    if (changedProperties.has("displayMode")) {
      if (this.displayMode === "fullscreen") {
        promoteToPopoverTopLayer(this);
      } else {
        this.removeAttribute("popover");
      }
    }
    if (this.resources) {
      this.resources.iframe.title = this.title || t("mcpApp.title");
      if (
        changedProperties.has("height") ||
        changedProperties.has("fillContainer") ||
        changedProperties.has("displayMode") ||
        changedProperties.has("deepLink")
      ) {
        this.resources.frameHeight = this.height;
        this.resources.iframe.style.height =
          this.fillContainer || this.displayMode === "fullscreen" ? "100%" : `${this.height}px`;
        this.resources.updateHostContext?.();
      }
    }
  }

  private async request(
    binding: McpAppBinding,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      const { agentId: _untrustedAgent, ...operationParams } = params;
      const requestParams = {
        ...operationParams,
        sessionKey: binding.sessionKey,
        viewId: binding.viewId,
        ...(binding.agentId ? { agentId: binding.agentId } : {}),
      };
      return await (signal
        ? binding.client.request(method, requestParams, { signal })
        : binding.client.request(method, requestParams));
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
    this.setupTask.abort();
    await this.teardownResources(this.resources);
  }

  /** Restarts a torn-down view only when its parent kept the element connected. */
  restartAfterTeardown() {
    if (!this.isConnected || this.resources || this.teardownPromise) {
      return;
    }
    void this.setupTask.run();
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
      const payload = (await this.request(
        binding,
        "mcp.app.view",
        {},
        signal,
      )) as McpAppViewPayload;
      const mount = this.mount.value;
      signal.throwIfAborted();
      this.inactive = payload.messageSupported === false ? "reconstructed" : null;
      if (!mount) {
        throw new Error(t("mcpApp.errors.mountUnavailable"));
      }
      const iframe = document.createElement("iframe");
      iframe.title = this.title || t("mcpApp.title");
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
          reject(new Error(t("mcpApp.errors.sandboxTimedOut")));
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
        t("mcpApp.errors.invalidSandboxUrl"),
      );
      await proxyReady;
      signal.throwIfAborted();
      if (!iframe.contentWindow) {
        throw new Error(t("mcpApp.errors.sandboxUnavailable"));
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
      const request = (method: string, params: Record<string, unknown>) =>
        this.request(binding, method, params);
      const isCurrent = () => this.isCurrentBinding(binding, createdResources, signal);
      const confirm = (text: string, kind: "message" | "file") =>
        this.confirmation.request({
          frame: iframe,
          title: this.title || t("mcpApp.title"),
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
        return request("mcp.app.modelContext", {})
          .then((response) => (response as { state: McpAppContextState }).state)
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
          const result = await request("mcp.app.updateModelContext", { ...params });
          await refreshModelContext();
          return result as { _meta?: Record<string, unknown> };
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
        if (height !== undefined && !this.fillContainer && this.displayMode !== "fullscreen") {
          const nextHeight = Math.min(1200, Math.max(160, Math.round(height)));
          createdResources.frameHeight = nextHeight;
          iframe.style.height = `${nextHeight}px`;
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
              () => reject(new Error(t("mcpApp.errors.initializationTimedOut"))),
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
        arguments:
          payload.toolInput &&
          typeof payload.toolInput === "object" &&
          !Array.isArray(payload.toolInput)
            ? (payload.toolInput as Record<string, unknown>)
            : {},
      });
      await bridge.sendToolResult(payload.toolResult as never);
      signal.throwIfAborted();
      return createdResources;
    } catch (error) {
      await this.teardownResources(resources);
      throw error;
    }
  }

  override render() {
    const error =
      this.inactive !== "ended" && this.setupTask.status === TaskStatus.ERROR
        ? this.setupTask.error
        : null;
    const relaunch = this.inactive === "ended" && this.onRelaunch;
    return html`${
        this.displayMode === "fullscreen"
          ? html`<button
              class="exit-fullscreen"
              @click=${() => {
                this.displayMode = "inline";
              }}
            >
              ${t("common.close")}
            </button>`
          : nothing
      }
      ${
        this.inactive && this.surface === "conversation"
          ? html`<div class="inactive" role="status">
              <span>${t(relaunch ? "mcpApp.sessionEnded" : "mcpApp.reconstructed")}</span>
              ${relaunch ? html`<button type="button" ?disabled=${this.relaunching} @click=${relaunch}>${t("mcpApp.relaunch")}</button>` : nothing}
            </div>`
          : nothing
      }
      ${this.confirmation.render()}
      <div ${ref(this.mount)} class="mount"></div>
      ${error ? html`<div class="error">${t("mcpApp.unavailable", { error: formatUiError(error, t("mcpApp.errors.requestFailed")) })}</div>` : nothing}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mcp-app-view": McpAppView;
  }
}
