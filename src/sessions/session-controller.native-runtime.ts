import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  getActiveNativeAttempt,
  getEmbeddedRunAttachment,
  type ActiveEmbeddedRunAttachment,
} from "../agents/embedded-agent-runner/run-state.js";
import { diagnosticLogger as diag } from "../logging/diagnostic.js";
import {
  waitForReplyOperationOwnerSettlement,
  waitForReplyRunEndBySessionId,
} from "./session-controller.settlement.js";

/** Starts bounded observation after an effect, retaining the producer captured before it. */
export async function waitForCapturedSessionNativeAttemptEnd(
  sessionId: string,
  timeoutMs: number | null,
  registration: ActiveEmbeddedRunAttachment | undefined,
): Promise<boolean> {
  if (!registration) {
    return true;
  }
  const settled = Promise.all([
    registration.settlement.promise,
    registration.runCleanupSettlement,
  ]).then(() => true);
  if (timeoutMs === null) {
    return await settled;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => {
            diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
            resolve(false);
          },
          resolveTimerTimeoutMs(timeoutMs, 100, 100),
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Joins the exact native attempt and controller owner captured for a session run. */
export async function waitForSessionRunEnd(
  sessionId: string,
  timeoutMs: number | null = 15_000,
): Promise<boolean> {
  const handle = getActiveNativeAttempt(sessionId);
  const attachment = handle ? getEmbeddedRunAttachment(handle) : undefined;
  const operation = attachment?.operation;
  const nativeSettlement = waitForCapturedSessionNativeAttemptEnd(sessionId, timeoutMs, attachment);
  const ownerSettlement = operation
    ? timeoutMs === null
      ? operation.ownerSettlement.then(() => true)
      : waitForReplyOperationOwnerSettlement(operation, timeoutMs)
    : handle
      ? Promise.resolve(true)
      : waitForReplyRunEndBySessionId(sessionId, timeoutMs);
  const [nativeSettled, ownerSettled] = await Promise.all([nativeSettlement, ownerSettlement]);
  return nativeSettled && ownerSettled;
}
