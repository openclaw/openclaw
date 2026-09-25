import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayServer } from "../gateway/server.js";
import { withTuiAfterUpdateGate } from "../tui/tui-update-gate.js";

const HATCH_TUI_TIMEOUT_MS = 5 * 60 * 1000;

type SessionGatewayHandle = { current: GatewayServer | undefined };

export async function runSetupTui(params: {
  config: OpenClawConfig;
  gatewayReachable: boolean;
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  message?: string;
  sessionGateway: SessionGatewayHandle;
  closeSessionGateway: (gateway: GatewayServer) => Promise<void>;
}): Promise<void> {
  restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: false });
  let loadedTuiLifecycle: typeof import("../tui/tui.js") | undefined;
  try {
    await withTuiAfterUpdateGate(async (tuiLifecycle) => {
      loadedTuiLifecycle = tuiLifecycle;
      await tuiLifecycle.runTui({
        ...(params.gatewayReachable
          ? {
              config: params.config,
              boundGateway: {
                url: params.gatewayUrl,
                ...(params.gatewayToken ? { token: params.gatewayToken } : {}),
                ...(params.gatewayPassword ? { password: params.gatewayPassword } : {}),
              },
            }
          : { local: true }),
        deliver: false,
        message: params.message,
        initialMessageTimeoutMs: HATCH_TUI_TIMEOUT_MS,
      });
    });
  } finally {
    restoreTerminalState("post-setup tui", { resumeStdinIfPaused: false });
    if (params.sessionGateway.current) {
      // A local session Gateway can own slow provider and child-process teardown.
      // Arm the TUI lifecycle's hard exit only after that graph is safely loaded.
      const cleanupExitTimer = loadedTuiLifecycle?.scheduleProcessExitAfterTuiReturn({
        delayMs: loadedTuiLifecycle.resolveTuiShutdownHardExitMs({ localMode: true }),
      });
      try {
        await params.closeSessionGateway(params.sessionGateway.current);
        params.sessionGateway.current = undefined;
      } finally {
        if (cleanupExitTimer) {
          loadedTuiLifecycle?.cancelProcessExitAfterTuiReturn(cleanupExitTimer);
        }
      }
    }
  }
  if (!loadedTuiLifecycle) {
    // An update crossed the startup gate. The stale owner has completed its
    // Gateway cleanup; the operator can now enter through the updated CLI.
    return;
  }
  // Setup cleanup must finish before the in-process TUI fallback may exit.
  loadedTuiLifecycle.scheduleProcessExitAfterTuiReturn();
}
