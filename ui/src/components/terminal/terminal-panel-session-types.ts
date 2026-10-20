import type {
  createTerminalDefaultColorQueryResponder,
  CreateGhosttyTerminalOptions,
  GhosttyTerminalController,
} from "@openclaw/libterminal/browser";
import { parseCatalogSessionKey, type CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import type { TerminalPanelTab } from "./terminal-panel-tabs.tsx";
import type { TerminalPanelUpload } from "./terminal-panel-upload.ts";
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

export type TerminalInputs = {
  gatewayConnected: boolean;
  client: TerminalGatewayClient | null;
  agentId: string | null;
  sessionKey: string | null;
  available: boolean;
  suppressed: boolean;
  themeMode: "dark" | "light";
  basePath: string;
  fullscreen: boolean;
  embedded: boolean;
  onClose: (() => void) | undefined;
  tabsInHeader: boolean;
  page: boolean;
  routeTarget: TerminalRouteTarget;
  createTerminalController: (
    options: CreateGhosttyTerminalOptions,
    shouldFocusOnOpen?: () => boolean,
  ) => Promise<GhosttyTerminalController>;
  catalogReadyTimeoutMs: number;
};

export type TerminalOperation = {
  generation: number;
  client: TerminalGatewayClient;
  signal: AbortSignal;
  cancelIntent?: () => void;
};

export type TerminalRestoreBatch = {
  operation: TerminalOperation;
  pending: Map<string, TerminalPanelSessionTab | undefined>;
  userClosedTab: boolean;
  input: { interacted: boolean; stop: () => void };
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

export type TerminalPanelError = {
  text: string;
  retryAction?: TerminalPanelOpenAction | { kind: "resume" };
};

export type TerminalPanelSessionState = {
  tabs: TerminalPanelSessionTab[];
  activeId: string | null;
  booting: boolean;
  error: TerminalPanelError | null;
};

export interface TerminalPanelSessionHost {
  readonly inputs: HTMLElement & TerminalInputs;
  readonly updateComplete: Promise<unknown>;
  publish(): void;
  readonly isConnected: boolean;
  readonly terminalFontFamily: string;
  readonly terminalPanelOpen: boolean;
  readonly terminalPanelUploadController: TerminalPanelUpload;
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
