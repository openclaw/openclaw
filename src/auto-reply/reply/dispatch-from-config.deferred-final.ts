import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanDeferredFinalText } from "../../tts/captioned-final.js";
import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";

/** Sends the deferred block text when execution exits before normal finalization. */
export async function flushDispatchDeferredFinalText(
  state: PrepareDispatchExecutionReadyState,
): Promise<boolean> {
  try {
    if (!state.deferFinalTtsText || state.params.replyOptions?.isHeartbeat === true) {
      return false;
    }
    const deferredVisibleText = state.cleanBlockTtsDirectiveText
      ? cleanDeferredFinalText(state.progressState.accumulatedBlockTtsText)
      : state.progressState.accumulatedBlockText;
    if (!deferredVisibleText.trim()) {
      return false;
    }
    const fallback = await state.sendFinalPayload(
      { text: deferredVisibleText },
      { abortSignal: state.isDispatchOperationAborted() ? false : undefined, skipTts: true },
    );
    if (!fallback.queuedFinal && fallback.routedFinalCount === 0) {
      return false;
    }
    state.progressState.accumulatedBlockText = "";
    state.progressState.accumulatedBlockTtsText = "";
    return true;
  } catch (error) {
    // Recovery must not replace the original resolver or cancellation outcome.
    logVerbose(
      `dispatch-from-config: deferred final text fallback failed: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}
