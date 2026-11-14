import type { ApplicationContext } from "../app/context.ts";
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { OpenClawAppBridge } from "./mcp-app-bridge.ts";
import type { McpAppContextState, McpAppHostSandboxCsp } from "./mcp-app-security.ts";

export type McpAppViewPayload = {
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

export type McpAppResources = {
  bridge: OpenClawAppBridge | null;
  requestAbort: AbortController;
  cleanups: Set<() => void>;
  frameHeight: number;
  iframe: HTMLIFrameElement;
  transport: { close(): Promise<void> } | null;
  disposed: boolean;
  updateHostContext?: () => void;
  reconnect?: () => Promise<void>;
};
export type McpAppBinding = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  sessionKey: string;
  viewId: string;
  agentId?: string;
  connectionRevision: number | undefined;
  scope: number;
};

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
  onHeightChange: ((height: number | null, settled?: boolean) => number | undefined) | undefined;
  relaunching: boolean;
  displayMode: "inline" | "fullscreen";
};
export type ViewMethods = { teardown(): Promise<void>; restartAfterTeardown(): void };
export type McpAppViewElement = SolidBridgeElement<McpAppViewProps, ViewMethods>;
