import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { t } from "../../i18n/index.ts";
import type {
  TerminalConnection,
  TerminalGatewayClient,
  TerminalOpenResult,
} from "./terminal-connection.ts";
import {
  disposeTerminalController,
  replaceTerminalController,
} from "./terminal-controller-lifecycle.ts";
import { updateTerminalFont } from "./terminal-fonts.ts";
import {
  TERMINAL_OUTPUT_ENCODER,
  shellBasename,
  type TerminalPanelSessionHost,
  type TerminalPanelSessionState,
  type TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";
import { createTerminalStartupInput } from "./terminal-startup-input.ts";
import type { createTerminalTabReadiness } from "./terminal-tab-readiness.ts";
import { terminalDynamicColors, terminalTheme } from "./terminal-theme.ts";

type TerminalSink = Parameters<TerminalConnection["open"]>[1];

export function captureTerminalDeliveryError(
  host: TerminalPanelSessionHost,
  state: TerminalPanelSessionState,
  client: TerminalGatewayClient | null,
  tab: TerminalPanelSessionTab,
  setError: (text: string) => void,
): () => void {
  // Delivery uncertainty belongs to the retained tab and identity, not the transport epoch.
  const recoveryScope = client?.recoveryScope;
  return () => {
    if (
      host.isConnected &&
      host.inputs.client === client &&
      client?.recoveryScope === recoveryScope &&
      !client?.offlineRecoveryRetired &&
      state.tabs.includes(tab)
    ) {
      setError(t("terminal.deliveryFailed"));
    }
  };
}

export function adoptTerminalPanelSession(params: {
  tab: TerminalPanelSessionTab;
  result: TerminalOpenResult;
  agentOwned: boolean;
  connection: TerminalConnection | null;
  readiness: ReturnType<typeof createTerminalTabReadiness<TerminalPanelSessionTab>>;
  onDeliveryError: () => void;
}): void {
  const { tab, result } = params;
  delete tab.cancelPendingIntent;
  tab.gatewaySessionId = result.sessionId;
  tab.shellName = result.title ?? shellBasename(result.shell);
  tab.shell = result.shell;
  tab.agentId = result.agentId;
  tab.cwd = result.cwd;
  tab.agentOwned =
    result.owner !== undefined ? result.owner.startsWith("agent:") : params.agentOwned;
  // Libterminal observes layout before the Gateway session exists. Resync the
  // current grid now so a resize during the open/attach RPC is not lost.
  const pendingInput = tab.pendingInput.drain();
  if (tab.status !== "exited") {
    const { cols, rows } = tab.controller.terminal;
    void params.connection
      ?.resize(result.sessionId, cols || 80, rows || 24)
      .catch(params.onDeliveryError);
    for (const data of pendingInput) {
      void params.connection?.input(result.sessionId, data).catch(params.onDeliveryError);
    }
  }
  if (tab.status === "connecting") {
    if (tab.awaitFirstOutput) {
      params.readiness.arm(tab);
    } else {
      params.readiness.markReady(tab);
    }
  }
}

/** Restore is passive once the user gives the document newer pointer or keyboard intent. */
export function observeTerminalRestoreInput(document: Document, signal: AbortSignal) {
  const input = { interacted: false, stop };
  const onInteraction = () => {
    input.interacted = true;
  };
  function stop() {
    document.removeEventListener("pointerdown", onInteraction, true);
    document.removeEventListener("keydown", onInteraction, true);
    signal.removeEventListener("abort", stop);
  }
  document.addEventListener("pointerdown", onInteraction, true);
  document.addEventListener("keydown", onInteraction, true);
  signal.addEventListener("abort", stop, { once: true });
  return input;
}

/** Creates the emulator and stream sink; the session controller owns tab adoption. */
export async function bootTerminalPanelSession(params: {
  panel: Pick<
    TerminalPanelSessionHost,
    "inputs" | "updateComplete" | "terminalFontFamily" | "findTerminalPanelViewport"
  >;
  connection: TerminalConnection;
  sequence: number;
  awaitFirstOutput: boolean;
  isCurrent: () => boolean;
  shouldFocusOnOpen?: () => boolean;
  onReady: (tab: TerminalPanelSessionTab) => void;
  onExit: (tab: TerminalPanelSessionTab, info: Parameters<TerminalSink["onExit"]>[0]) => void;
  captureDeliveryError: (tab: TerminalPanelSessionTab) => (error: unknown) => void;
}) {
  const { panel, connection } = params;
  const host = document.createElement("div");
  host.className = "tp-host";
  // The emulator needs the panel viewport to be laid out before it can measure its grid.
  await panel.updateComplete;
  if (!params.isCurrent()) {
    throw new Error("terminal operation cancelled");
  }
  const viewport = panel.findTerminalPanelViewport();
  if (!viewport) {
    throw new Error("terminal viewport unavailable");
  }
  viewport.append(host);
  const tabReference: { current?: TerminalPanelSessionTab } = {};
  const startupInput = createTerminalStartupInput(
    connection,
    () =>
      tabReference.current?.status === "exited"
        ? undefined
        : tabReference.current?.gatewaySessionId,
    () => (tabReference.current ? params.captureDeliveryError(tabReference.current) : () => {}),
    () =>
      panel.inputs.gatewayConnected &&
      panel.inputs.available &&
      !tabReference.current?.controller.readOnly,
  );
  const { createTerminalDefaultColorQueryResponder } =
    await import("@openclaw/libterminal/browser");
  const defaultColorQueries = createTerminalDefaultColorQueryResponder({
    getColors: terminalDynamicColors,
    reply: (data) => startupInput.onData(TERMINAL_OUTPUT_ENCODER.encode(data)),
  });
  const createController = (parent: HTMLElement, controllerOptions?: { readOnly?: boolean }) =>
    panel.inputs.createTerminalController(
      {
        parent,
        readOnly: controllerOptions?.readOnly ?? false,
        terminalOptions: {
          fontSize: 11,
          fontFamily: panel.terminalFontFamily,
          cursorBlink: true,
          theme: terminalTheme(panel.inputs.themeMode),
          scrollback: 5000,
        },
        // The session owner explicitly disposes adopted views. A completed view
        // can move to another panel, so it must not retain the old owner's signal.
        // The post-create current check below disposes cancelled in-flight boots.
        // The browser controller owns these subscriptions and their teardown.
        onData: startupInput.onData,
        onResize: startupInput.onResize,
      },
      params.shouldFocusOnOpen &&
        (() => params.isCurrent() && params.shouldFocusOnOpen?.() !== false),
    );
  let controller: GhosttyTerminalController;
  try {
    controller = await createController(host);
  } catch (error) {
    host.remove();
    throw error;
  }
  if (!params.isCurrent()) {
    disposeTerminalController(controller, host);
    throw new Error("terminal operation cancelled");
  }
  const tab: TerminalPanelSessionTab = {
    id: `tab-${params.sequence}`,
    sequence: params.sequence,
    gatewaySessionId: "",
    pendingInput: startupInput.buffer,
    defaultColorQueries,
    shellName: null,
    shell: "",
    agentId: null,
    cwd: null,
    agentOwned: false,
    controller,
    host,
    status: "connecting",
    awaitFirstOutput: params.awaitFirstOutput,
    readyTimer: null,
  };
  tabReference.current = tab;
  const sink: TerminalSink = {
    // Buffered events may replay after the owning session has disposed its tab.
    onData: (data: string) => {
      if (!tab.cancelled) {
        tab.defaultColorQueries.observe(data);
        tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(data));
        if (data.length > 0) {
          params.onReady(tab);
        }
      }
    },
    onReplay: ({ data, newlyObservedFrom, mode, signal }) => {
      if (tab.cancelled || signal.aborted) {
        return undefined;
      }
      // Suppress historical queries, then answer only the recovered suffix, including split queries.
      tab.defaultColorQueries.primeFromReplay(data.slice(0, newlyObservedFrom));
      tab.defaultColorQueries.observe(data.slice(newlyObservedFrom));
      if (mode === "resume") {
        const suffix = data.slice(newlyObservedFrom);
        if (suffix) {
          tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(suffix));
          params.onReady(tab);
        }
        return undefined;
      }
      if (mode === "recovery") {
        return replaceTerminalController(tab, createController, data, signal).then((replaced) => {
          if (replaced && !tab.cancelled && !signal.aborted) {
            // Preferences may change during creation or deferred publication.
            // An already-live tab does not schedule another panel render.
            updateTerminalFont(tab.controller, panel.terminalFontFamily);
            if (data) {
              params.onReady(tab);
            }
          }
        });
      }
      if (data) {
        tab.controller.write(TERMINAL_OUTPUT_ENCODER.encode(data));
        params.onReady(tab);
      }
      return undefined;
    },
    onExit: (info) => params.onExit(tab, info),
  };
  return {
    tab,
    connection,
    cols: controller.terminal.cols || 80,
    rows: controller.terminal.rows || 24,
    sink,
  };
}
