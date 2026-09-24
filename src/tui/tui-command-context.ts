import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { Result } from "@openclaw/normalization-core/result";
import type { SessionsPatchResult } from "../../packages/gateway-protocol/src/index.js";
import type { ChatLog } from "./components/chat-log.js";
import type { TuiBackend, TuiSessionMutationResult } from "./tui-backend.js";
import type { createTuiLocalCliRunner } from "./tui-local-cli.js";
import type { TuiOptions, TuiResult, TuiStateAccess } from "./tui-types.js";

export type CommandHandlerContext = {
  client: TuiBackend;
  chatLog: ChatLog;
  tui: TUI;
  opts: TuiOptions;
  state: TuiStateAccess;
  deliverDefault: boolean;
  openOverlay: (component: Component) => OverlayHandle;
  closeOverlay: (handle?: OverlayHandle) => void;
  refreshSessionInfo: () => Promise<void>;
  loadHistory: () => Promise<unknown>;
  setSession: (key: string, agentId?: string) => Promise<void>;
  refreshAgents: (ownsRefresh?: () => boolean) => Promise<Result<void, string>>;
  abortActive: (params?: { preferActive?: boolean }) => Promise<void>;
  setActivityStatus: (text: string) => void;
  formatSessionKey: (key: string) => string;
  applySessionInfoFromPatch: (result: SessionsPatchResult) => void;
  applySessionMutationResult: (
    result?: TuiSessionMutationResult | null,
    requestSelection?: { sessionKey: string; agentId: string },
  ) => boolean;
  noteLocalRunId?: (runId: string) => void;
  noteLocalBtwRunId?: (runId: string) => void;
  forgetLocalRunId?: (runId: string) => void;
  forgetLocalBtwRunId?: (runId: string) => void;
  consumeCompletedRunForPendingSend?: (runId: string) => boolean;
  isRunObserved?: (runId: string) => boolean;
  flushPendingHistoryRefreshIfIdle?: () => void;
  reopenQuestion?: () => void | Promise<void>;
  runAuthFlow?: (params: { provider?: string }) => Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    commandArgv: string;
  }>;
  localCli?: ReturnType<typeof createTuiLocalCliRunner>;
  requestExit: (result?: Partial<TuiResult>) => void;
};
