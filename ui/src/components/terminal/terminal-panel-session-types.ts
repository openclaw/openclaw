import type {
  createTerminalDefaultColorQueryResponder,
  CreateGhosttyTerminalOptions,
  GhosttyTerminalController,
} from "@openclaw/libterminal/browser";
import type { ReactiveControllerHost } from "lit";
import { parseCatalogSessionKey, type CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import type { TerminalPanelTab } from "./terminal-panel-tabs.ts";
import type { TerminalPanelUploadController } from "./terminal-panel-upload.ts";
import type { StartupInputBuffer } from "./terminal-startup-input.ts";
import type { TerminalTabReadinessState } from "./terminal-tab-readiness.ts";

export type TerminalPanelSessionTab = TerminalPanelTab &
  TerminalTabReadinessState & {
    gatewaySessionId: string;
    pendingInput: StartupInputBuffer;
    defaultColorQueries: ReturnType<typeof createTerminalDefaultColorQueryResponder>;
    controller: GhosttyTerminalController;
    shell: string;
    host: HTMLDivElement;
    pendingOpen?: TerminalPanelOpenAction;
    /** Retires only the queued intent that booted this placeholder. */
    cancelPendingIntent?: () => void;
    /** Why an in-flight open/attach must not adopt this disposed terminal. */
    cancelled?: "close" | "lifecycle";
  };

export type TerminalRouteTarget = { sessionId: string } | { catalog: CatalogSessionKey } | null;

export type TerminalOperation = {
  generation: number;
  client: TerminalGatewayClient;
  signal: AbortSignal;
  cancelIntent?: () => void;
};

export function resolveTerminalPanelOwnerSessionKey(
  sessionKey: string | null,
  catalog?: CatalogSessionKey,
): string | undefined {
  const key = sessionKey?.trim();
  return !catalog && key && !parseCatalogSessionKey(key) ? key : undefined;
}

/** Explicit terminal work retained until it either runs or reports a visible failure. */
export type TerminalPanelAction =
  | { kind: "restore"; agentId: string | null }
  | { kind: "open"; agentId: string | null }
  | { kind: "catalog"; agentId: string | null; catalog: CatalogSessionKey }
  | { kind: "attach"; sessionId: string; agentOwned: boolean };

export type TerminalPanelOpenAction = Extract<TerminalPanelAction, { kind: "catalog" | "open" }>;

export type TerminalPanelError = { text: string; retryAction?: TerminalPanelOpenAction };

export type TerminalPanelSessionControllerState = {
  tabs: TerminalPanelSessionTab[];
  activeId: string | null;
  booting: boolean;
  error: TerminalPanelError | null;
};

export interface TerminalPanelSessionControllerHost extends ReactiveControllerHost {
  readonly isConnected: boolean;
  readonly client: TerminalGatewayClient | null;
  readonly agentId: string | null;
  readonly sessionKey: string | null;
  readonly available: boolean;
  readonly themeMode: "dark" | "light";
  readonly terminalFontFamily: string;
  readonly fullscreen: boolean;
  readonly page: boolean;
  readonly routeTarget: TerminalRouteTarget;
  readonly terminalPanelOpen: boolean;
  readonly catalogReadyTimeoutMs: number;
  readonly terminalPanelUploadController: TerminalPanelUploadController;
  createTerminalController(
    options: CreateGhosttyTerminalOptions,
  ): Promise<GhosttyTerminalController>;
  closeTerminalPanel(): void;
  findTerminalPanelViewport(): Element | null;
  hideTerminalPanelForUnavailableSurface(): void;
  resetTerminalSessionPicker(): void;
  restoreTerminalPanelOpenState(): boolean;
}

export const TERMINAL_OUTPUT_ENCODER = new TextEncoder();

export function shellBasename(shell: string): string {
  return shell.split(/[\\/]/).pop()?.trim() || "shell";
}

export function forceTerminalRender(controller: GhosttyTerminalController): void {
  const term = controller.terminal;
  if (term.renderer && term.wasmTerm) {
    // An omitted opacity defaults to 1; repaint without inventing a visible scrollbar.
    term.renderer.render(term.wasmTerm, true, term.viewportY, term, 0);
  }
}
