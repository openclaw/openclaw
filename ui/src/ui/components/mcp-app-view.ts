import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.js";
import { getMcpAppContext } from "../mcp-app-context.js";
import { openExternalUrlSafe } from "../open-external-url.js";

type AppBridgeWithListTools = AppBridge & {
  onlisttools?: (params: { cursor?: string }) => Promise<{ tools: unknown[]; nextCursor?: string }>;
};

type McpUiHostCapabilities = ConstructorParameters<typeof AppBridge>[2];
type McpUiHostContext = NonNullable<
  NonNullable<ConstructorParameters<typeof AppBridge>[3]>["hostContext"]
>;

function coerceToolArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function currentTheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function currentLocale(): string | undefined {
  return navigator.language || navigator.languages?.[0];
}

function currentTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function hasTouchInput(): boolean {
  return navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)").matches;
}

function hasHoverInput(): boolean {
  return window.matchMedia?.("(hover: hover)").matches;
}

export function buildMcpAppHostContext(params: {
  width?: number;
  height?: number;
}): McpUiHostContext {
  const requestedWidth = params.width;
  const requestedHeight = params.height;
  const width =
    typeof requestedWidth === "number" && Number.isFinite(requestedWidth) && requestedWidth > 0
      ? Math.round(requestedWidth)
      : 0;
  const height =
    typeof requestedHeight === "number" && Number.isFinite(requestedHeight) && requestedHeight > 0
      ? Math.round(requestedHeight)
      : undefined;
  const touch = hasTouchInput();
  const locale = currentLocale();
  const timeZone = currentTimeZone();
  const containerDimensions = {
    ...(width > 0 ? { width } : { maxWidth: window.innerWidth }),
    ...(height ? { height } : { maxHeight: window.innerHeight }),
  } as McpUiHostContext["containerDimensions"];
  return {
    theme: currentTheme(),
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions,
    ...(locale ? { locale } : {}),
    ...(timeZone ? { timeZone } : {}),
    platform: touch && window.innerWidth < 768 ? "mobile" : "web",
    deviceCapabilities: {
      touch,
      hover: hasHoverInput(),
    },
    safeAreaInsets: {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
  };
}

export function resolveMcpAppSandboxMode(
  mode: EmbedSandboxMode | null | undefined,
): EmbedSandboxMode {
  return mode === "trusted" ? "scripts" : (mode ?? "scripts");
}

export function resolveMcpAppIframeSandbox(mode: EmbedSandboxMode | null | undefined): string {
  return [resolveEmbedSandbox(resolveMcpAppSandboxMode(mode)), "allow-forms"]
    .filter(Boolean)
    .join(" ");
}

export class McpAppView extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
    }
    .mcp-app-container {
      width: 100%;
      position: relative;
    }
    .mcp-app-error {
      color: var(--error, #e53e3e);
      padding: 0.5rem;
      font-size: 0.85em;
    }
  `;

  @property() src = "";
  @property() sandboxMode: EmbedSandboxMode = "scripts";
  @property({ type: Number }) height = 600;
  @property({ attribute: "mcp-title" }) mcpTitle = "MCP App";
  @property({ attribute: false }) mcpServerName = "";
  @property({ attribute: false }) mcpSessionKey = "";
  @property({ attribute: false }) mcpToolInput: unknown;
  @property({ attribute: false }) mcpToolResult: unknown;

  @state() private _error: string | null = null;
  @state() private _viewInitialized = false;

  private _bridge: AppBridge | null = null;
  private _closeTransport: (() => void) | null = null;
  private _iframe: HTMLIFrameElement | null = null;
  private _disposed = false;
  private _currentSrc: string | null = null;
  private _sentToolInput = false;
  private _sentToolResult = false;

  override connectedCallback() {
    super.connectedCallback();
    this._disposed = false;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._teardown();
  }

  override async updated(changed: Map<string, unknown>) {
    if (changed.has("src") && this.src !== this._currentSrc) {
      await this._setupBridge();
      return;
    }
    if (this._viewInitialized && (changed.has("mcpToolInput") || changed.has("mcpToolResult"))) {
      this._sendPendingToolData();
    }
  }

  private _teardown() {
    this._disposed = true;
    if (this._bridge) {
      this._bridge.teardownResource({}).catch(() => {});
      this._bridge = null;
    }
    if (this._closeTransport) {
      this._closeTransport();
      this._closeTransport = null;
    }
    if (this._iframe) {
      this._iframe.remove();
      this._iframe = null;
    }
    this._viewInitialized = false;
    this._currentSrc = null;
    this._sentToolInput = false;
    this._sentToolResult = false;
  }

  private async _setupBridge() {
    this._teardown();
    this._disposed = false;
    this._currentSrc = this.src;

    if (!this.src) {
      return;
    }

    const ctx = getMcpAppContext();

    try {
      const container = this.shadowRoot?.querySelector(".mcp-app-container");
      if (!container) {
        return;
      }

      const bridge = new AppBridge(
        null,
        { name: "OpenClaw", version: "1.0.0" },
        this._buildHostCapabilities(),
        { hostContext: this._buildHostContext(container) },
      );

      const sessionKey = this.mcpSessionKey || ctx.sessionKey || "";
      if (ctx.client && sessionKey && this.mcpServerName) {
        const client = ctx.client;
        const serverName = this.mcpServerName;

        bridge.oncalltool = async (params) => {
          return await client.request("mcp.callTool", {
            sessionKey,
            serverName,
            toolName: params.name,
            arguments: params.arguments,
          });
        };

        (bridge as AppBridgeWithListTools).onlisttools = async (params) => {
          return await client.request("mcp.listTools", {
            sessionKey,
            serverName,
            ...(params?.cursor ? { cursor: params.cursor } : {}),
          });
        };

        bridge.onlistresources = async (params) => {
          return await client.request("mcp.listResources", {
            sessionKey,
            serverName,
            ...(params?.cursor ? { cursor: params.cursor } : {}),
          });
        };

        bridge.onlistresourcetemplates = async (params) => {
          return await client.request("mcp.listResourceTemplates", {
            sessionKey,
            serverName,
            ...(params?.cursor ? { cursor: params.cursor } : {}),
          });
        };

        bridge.onreadresource = async (params) => {
          return await client.request("mcp.readResource", {
            sessionKey,
            serverName,
            uri: params.uri,
          });
        };
      }

      // AppBridge exposes protocol callback properties, not EventTarget listeners.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      bridge.onopenlink = async ({ url }) => (openExternalUrlSafe(url) ? {} : { isError: true });

      this._bridge = bridge;

      const iframe = document.createElement("iframe");
      iframe.style.width = "100%";
      iframe.style.height = `${this.height}px`;
      iframe.style.border = "none";
      iframe.style.backgroundColor = "transparent";
      iframe.setAttribute("sandbox", resolveMcpAppIframeSandbox(this.sandboxMode));
      iframe.setAttribute("title", this.mcpTitle);
      container.appendChild(iframe);
      this._iframe = iframe;

      if (this._disposed || !iframe.contentWindow) {
        return;
      }

      const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
      this._closeTransport = () => {
        transport.close().catch(() => {});
      };

      bridge.onsizechange = (params) => {
        if (this._iframe) {
          if (params.height !== undefined) {
            this._iframe.style.height = `${params.height}px`;
          }
          if (params.width !== undefined) {
            this._iframe.style.width = `${params.width}px`;
          }
          bridge.setHostContext(this._buildHostContext(container));
        }
      };

      bridge.oninitialized = () => {
        if (this._disposed) {
          return;
        }
        this._viewInitialized = true;
        this._sendPendingToolData();
      };

      const connectPromise = bridge.connect(transport);
      const loadPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("MCP App iframe load timeout")), 15000);
        iframe.addEventListener("load", () => {
          clearTimeout(timeout);
          resolve();
        });
        iframe.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("MCP App iframe load failed"));
        });
      });

      iframe.src = this.src;
      await Promise.all([loadPromise, connectPromise]);
      if (this._disposed) {
        return;
      }
      this._error = null;
    } catch (err) {
      if (!this._disposed) {
        const message = err instanceof Error ? err.message : String(err);
        this._teardown();
        this._disposed = false;
        this._error = message;
      }
    }
  }

  private _buildHostCapabilities(): McpUiHostCapabilities {
    return {
      openLinks: {},
      serverResources: {},
      serverTools: {},
    };
  }

  private _buildHostContext(container: Element | null | undefined): McpUiHostContext {
    const rect = container?.getBoundingClientRect();
    return buildMcpAppHostContext({
      width: rect?.width || this._iframe?.clientWidth || this.clientWidth || undefined,
      height: this._iframe?.clientHeight || this.height,
    });
  }

  private _sendPendingToolData() {
    const bridge = this._bridge;
    if (!bridge || !this._viewInitialized || this._disposed) {
      return;
    }
    if (!this._sentToolInput) {
      this._sentToolInput = true;
      bridge.sendToolInput({ arguments: coerceToolArguments(this.mcpToolInput) }).catch(() => {});
    }
    if (!this._sentToolResult && this.mcpToolResult !== undefined) {
      this._sentToolResult = true;
      bridge
        .sendToolResult(this.mcpToolResult as Parameters<AppBridge["sendToolResult"]>[0])
        .catch(() => {});
    }
  }

  override render() {
    return html`
      <div class="mcp-app-container">
        ${this._error
          ? html`<div class="mcp-app-error">MCP App error: ${this._error}</div>`
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get("mcp-app-view")) {
  customElements.define("mcp-app-view", McpAppView);
}

declare global {
  interface HTMLElementTagNameMap {
    "mcp-app-view": McpAppView;
  }
}
