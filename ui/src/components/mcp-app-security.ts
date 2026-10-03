import type { ContentBlock } from "@modelcontextprotocol/client";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { mcpAppMessageText } from "../lib/mcp-app-message-content.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

type McpAppHostCapabilities = ConstructorParameters<typeof AppBridge>[2];
registerMcpAppEnglish();

export type McpAppHostSandboxCsp = NonNullable<
  NonNullable<McpAppHostCapabilities["sandbox"]>["csp"]
>;

/** Bubbling event handled by the owning chat pane through its normal send path. */
export const WIDGET_PROMPT_EVENT = "openclaw-widget-prompt";
export type WidgetPromptEventDetail = { text: string };
export const MCP_APP_VIEW_EXPIRED_EVENT = "openclaw-mcp-app-view-expired";

const WIDGET_PROMPT_MAX_CHARS = 4_000;
const WIDGET_PROMPT_RATE_WINDOW_MS = 60_000;
const WIDGET_PROMPT_RATE_MAX = 10;
const WIDGET_PROMPT_RATE_KEYS_MAX = 100;
const widgetPromptTimestampsByKey = new Map<string, number[]>();

export function allowWidgetPrompt(key: string, nowMs: number): boolean {
  const cutoff = nowMs - WIDGET_PROMPT_RATE_WINDOW_MS;
  const timestamps = (widgetPromptTimestampsByKey.get(key) ?? []).filter((ts) => ts > cutoff);
  if (
    !widgetPromptTimestampsByKey.has(key) &&
    widgetPromptTimestampsByKey.size >= WIDGET_PROMPT_RATE_KEYS_MAX
  ) {
    const oldest = widgetPromptTimestampsByKey.keys().next().value;
    if (oldest !== undefined) {
      widgetPromptTimestampsByKey.delete(oldest);
    }
  }
  if (timestamps.length >= WIDGET_PROMPT_RATE_MAX) {
    widgetPromptTimestampsByKey.set(key, timestamps);
    return false;
  }
  timestamps.push(nowMs);
  widgetPromptTimestampsByKey.set(key, timestamps);
  return true;
}

export function isWidgetFrameInteractable(frame: HTMLIFrameElement): boolean {
  if (!frame.isConnected) {
    return false;
  }
  const visible =
    typeof frame.checkVisibility === "function"
      ? frame.checkVisibility()
      : frame.getClientRects().length > 0;
  if (!visible) {
    return false;
  }
  let active: Element | null = frame.ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active === frame;
}

/**
 * Agent-authored frames may submit only user-focused conversational text.
 * The shared event preserves pane routing and prevents privileged shortcuts.
 */
export async function dispatchWidgetPrompt(
  frame: HTMLIFrameElement,
  raw: unknown,
  rateKey: string,
  confirmPrompt?: (text: string) => boolean | Promise<boolean>,
  isCurrent?: () => boolean,
): Promise<boolean> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (
    !text ||
    text.length > WIDGET_PROMPT_MAX_CHARS ||
    text.startsWith("/") ||
    text.startsWith("!") ||
    !isWidgetFrameInteractable(frame) ||
    !allowWidgetPrompt(rateKey, Date.now())
  ) {
    return false;
  }
  if (
    (confirmPrompt && !(await confirmPrompt(text))) ||
    isCurrent?.() === false ||
    !isWidgetFrameInteractable(frame)
  ) {
    return false;
  }
  frame.dispatchEvent(
    new CustomEvent<WidgetPromptEventDetail>(WIDGET_PROMPT_EVENT, {
      bubbles: true,
      composed: true,
      detail: { text },
    }),
  );
  return true;
}

export function buildMcpAppHostCapabilities(
  csp?: McpAppHostSandboxCsp,
  supportsMessage = false,
  supportsUpdateModelContext = false,
  supportsServerResources = false,
  extensions: {
    richModelContext?: boolean;
    richMessage?: boolean;
    fileResources?: boolean;
    openFiles?: boolean;
  } = {},
): McpAppHostCapabilities {
  return {
    openLinks: {},
    serverTools: {},
    sandbox: { csp: csp ?? {} },
    ...(supportsServerResources ? { serverResources: {} } : {}),
    ...(supportsMessage
      ? {
          message: {
            text: {},
            ...(extensions.richMessage ? { image: {}, resource: {}, resourceLink: {} } : {}),
          },
        }
      : {}),
    ...(supportsUpdateModelContext
      ? {
          updateModelContext: {
            text: {},
            ...(extensions.richModelContext
              ? { image: {}, resource: {}, resourceLink: {}, structuredContent: {} }
              : {}),
          },
        }
      : {}),
    experimental: {
      ...(extensions.richModelContext ? { "openai/modelContext": {} } : {}),
      ...(extensions.richMessage ? { "openai/message": {} } : {}),
      ...(extensions.fileResources ? { "openai/resource": {} } : {}),
      ...(extensions.openFiles ? { "openai/files": {} } : {}),
    },
  };
}

export function resolveMcpAppSandboxUrl(
  value: string,
  sandboxPort: number,
  sandboxOrigin: string | undefined,
  gatewayUrl: string,
  hostOrigin: string,
): string {
  return resolveSandboxHostUrl(
    value,
    sandboxPort,
    sandboxOrigin,
    gatewayUrl,
    hostOrigin,
    t("mcpApp.errors.invalidSandboxUrl"),
  );
}

/** The normal conversation/file owner must acknowledge custody; dispatch alone is not acceptance. */
export const MCP_APP_MESSAGE_EVENT = "openclaw-mcp-app-message";
export const MCP_APP_CONTEXT_EVENT = "openclaw-mcp-app-context";
export const MCP_APP_FILE_OPEN_EVENT = "openclaw-mcp-app-file-open";
export type McpAppMessageEventDetail = {
  sessionKey: string;
  viewId: string;
  content: ContentBlock[];
  target: "active" | "new";
  respond: (accepted: boolean) => void;
};
export type McpAppContextState = {
  updateId: string;
  content?: ContentBlock[];
  structuredContent?: Record<string, unknown>;
} | null;
export type McpAppContextEventDetail = {
  sessionKey: string;
  viewId: string;
  state: McpAppContextState;
};
export type McpAppFileOpenEventDetail = {
  sessionKey: string;
  viewId: string;
  path: string;
  name: string;
  respond: (accepted: boolean) => void;
};

function isSupportedMcpAppContent(block: ContentBlock): boolean {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" && block.text.trim().length > 0;
    case "image":
      return typeof block.data === "string" && Boolean(block.mimeType);
    case "resource_link":
      return (
        typeof block.uri === "string" &&
        Boolean(block.uri) &&
        typeof block.name === "string" &&
        Boolean(block.name)
      );
    case "resource":
      return (
        Boolean(block.resource) &&
        typeof block.resource.uri === "string" &&
        (("text" in block.resource && typeof block.resource.text === "string") ||
          ("blob" in block.resource && typeof block.resource.blob === "string"))
      );
    default:
      return false;
  }
}

export async function dispatchMcpAppMessage(
  frame: HTMLIFrameElement,
  binding: { sessionKey: string; viewId: string },
  params: { role: string; content: ContentBlock[]; _meta?: Record<string, unknown> },
  confirm: (preview: string) => boolean | Promise<boolean>,
  isCurrent?: () => boolean,
): Promise<boolean> {
  const options = params._meta?.["openai/message"];
  const messageOptions = asOptionalRecord(options);
  if (options !== undefined && !messageOptions) {
    return false;
  }
  if (
    params.role !== "user" ||
    !params.content.length ||
    params.content.some((block) => !isSupportedMcpAppContent(block)) ||
    (messageOptions?.target !== undefined &&
      messageOptions.target !== "active" &&
      messageOptions.target !== "new") ||
    (messageOptions?.send !== undefined && messageOptions.send !== true) ||
    JSON.stringify(params.content).length > 8 * 1024 * 1024 ||
    !isWidgetFrameInteractable(frame) ||
    !allowWidgetPrompt(binding.sessionKey + "\0" + binding.viewId, Date.now())
  ) {
    return false;
  }
  // Commands are host actions, never an untrusted App's conversational shortcut.
  if (/^[!/]/u.test(mcpAppMessageText(params.content).trimStart())) {
    return false;
  }
  const preview = params.content
    .map((block) => {
      const title = block._meta?.["openai/title"];
      if (typeof title === "string" && title.trim()) {
        return title;
      }
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "resource_link") {
        return block.title ?? block.name;
      }
      if (block.type === "resource") {
        return block.resource.uri;
      }
      return block.type;
    })
    .join("\n\n");
  if (!(await confirm(preview)) || isCurrent?.() === false || !isWidgetFrameInteractable(frame)) {
    return false;
  }
  return new Promise<boolean>((respond) => {
    const claimed = !frame.dispatchEvent(
      new CustomEvent<McpAppMessageEventDetail>(MCP_APP_MESSAGE_EVENT, {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: {
          ...binding,
          content: params.content,
          target: messageOptions?.target === "new" ? "new" : "active",
          respond,
        },
      }),
    );
    if (!claimed) {
      respond(false);
    }
  });
}

export function negotiateMcpAppDisplayModes(
  resource:
    | {
        availableDisplayModes?: Array<"inline" | "fullscreen">;
        preferredDisplayMode?: "inline" | "fullscreen";
      }
    | undefined,
  appModes?: readonly string[],
): { available: Array<"inline" | "fullscreen">; initial: "inline" | "fullscreen" } {
  const hints =
    resource?.availableDisplayModes ??
    (resource?.preferredDisplayMode ? [resource.preferredDisplayMode] : appModes);
  const available = (["inline", "fullscreen"] as const).filter(
    (mode) => (!hints || hints.includes(mode)) && (!appModes || appModes.includes(mode)),
  );
  if (!available.length) {
    throw new Error("MCP App supports no available host display mode");
  }
  return {
    available,
    initial:
      resource?.preferredDisplayMode && available.includes(resource.preferredDisplayMode)
        ? resource.preferredDisplayMode
        : available[0]!,
  };
}
