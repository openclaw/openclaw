import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { copyToClipboard } from "../infra/clipboard.js";
import { BtwOverlay } from "./components/btw-overlay.js";
import { createTuiRunIdTracker } from "./tui-session-run-coordinator.js";

type BtwResult = { question: string; text: string; isError?: boolean; runId?: string };

// Past this a reader hears nothing, so the wait is announced as a failure.
const BTW_ANSWER_TIMEOUT_MS = 60_000;

/**
 * Screen reader mode presents BTW results as one modal overlay instead of an inline card, and
 * announces when a side question is sent and when it ends without an answer.
 */
export function createBtwPresenter(deps: {
  screenReader: boolean;
  chatLog: {
    showBtw: (params: BtwResult) => unknown;
    dismissBtw: () => void;
    addSystem: (text: string) => void;
  };
  tui: Pick<TUI, "requestRender">;
  openOverlay: TUI["showOverlay"];
  closeOverlay: (handle: OverlayHandle) => void;
  copy?: (text: string) => Promise<boolean>;
  timeoutMs?: number;
}) {
  const runIds = createTuiRunIdTracker();
  const tracking = { isRunId: runIds.has, clearRunIds: runIds.clear };
  if (!deps.screenReader) {
    return {
      showResult: (params: BtwResult) => void deps.chatLog.showBtw(params),
      clear: () => deps.chatLog.dismissBtw(),
      ...tracking,
      noteRunId: runIds.note,
      forgetRunId: runIds.forget,
    };
  }
  let handle: OverlayHandle | null = null;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const liveRunIds = new Set<string>();
  const stopWaiting = () => {
    clearTimeout(waiting ?? undefined);
    waiting = null;
  };
  const clear = () => {
    if (handle) {
      deps.closeOverlay(handle);
      handle = null;
      deps.tui.requestRender();
    }
  };
  const showResult = ({ runId, ...params }: BtwResult) => {
    stopWaiting();
    clear();
    // The message-free final that follows a delivered answer must not read as "no answer".
    if (runId) {
      liveRunIds.delete(runId);
    }
    const overlay = new BtwOverlay(params, {
      close: clear,
      copy: deps.copy ?? copyToClipboard,
      requestRender: () => deps.tui.requestRender(),
    });
    handle = deps.openOverlay(overlay, { width: "100%" });
  };
  // The tracker sees each run id once or twice (provisional and accepted); announce once.
  const noteRunId = (runId: string) => {
    runIds.note(runId);
    liveRunIds.add(runId);
    if (waiting) {
      return;
    }
    deps.chatLog.addSystem("Asking side question");
    waiting = setTimeout(() => {
      waiting = null;
      deps.chatLog.addSystem("btw failed: no answer received. Check the model, then try again.");
      deps.tui.requestRender();
    }, deps.timeoutMs ?? BTW_ANSWER_TIMEOUT_MS);
    waiting.unref?.();
  };
  const forgetRunId = (runId: string, outcome?: "empty") => {
    runIds.forget(runId);
    if (liveRunIds.delete(runId) && outcome === "empty") {
      deps.chatLog.addSystem("btw ended without an answer.");
    }
    // Failures and empty finishes announce themselves; the timer is only for a run that never
    // reports back. The check waits a tick because a provisional id is forgotten just before the
    // accepted one is noted.
    queueMicrotask(() => {
      if (liveRunIds.size === 0) {
        stopWaiting();
      }
    });
  };
  // A session switch drops every tracked run, so nothing may announce into the new session.
  const clearRunIds = () => {
    runIds.clear();
    liveRunIds.clear();
    stopWaiting();
  };
  return { showResult, clear, noteRunId, forgetRunId, isRunId: runIds.has, clearRunIds };
}
