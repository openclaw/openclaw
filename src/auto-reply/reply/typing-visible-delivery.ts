import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { logVerbose } from "../../globals.js";

const VISIBLE_DELIVERY_TYPING_START_TIMEOUT_MS = 1000;

export async function runVisibleDeliveryTypingStart(params: {
  start: () => Promise<void> | void;
  timeoutMs?: number;
  onTimeout?: () => void;
  onLateCompletion?: () => void;
}): Promise<void> {
  const timeoutMs = resolveTimerTimeoutMs(
    params.timeoutMs,
    VISIBLE_DELIVERY_TYPING_START_TIMEOUT_MS,
    0,
  );
  const start = Promise.resolve()
    .then(() => params.start())
    .catch((error: unknown) => {
      logVerbose(`visible-delivery typing start failed: ${String(error)}`);
    });
  if (timeoutMs <= 0) {
    await start;
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([start.then(() => "done" as const), timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  if (result === "timeout") {
    try {
      params.onTimeout?.();
    } catch (error) {
      logVerbose(`visible-delivery typing timeout cleanup failed: ${String(error)}`);
    }
    void start.then(() => {
      try {
        params.onLateCompletion?.();
      } catch (error) {
        logVerbose(`visible-delivery typing late cleanup failed: ${String(error)}`);
      }
    });
    logVerbose(`visible-delivery typing start timed out after ${timeoutMs}ms; continuing delivery`);
  }
}
