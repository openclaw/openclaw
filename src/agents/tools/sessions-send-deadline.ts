import crypto from "node:crypto";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import { registerDiagnosticToolExecutionDeadline } from "../../infra/diagnostic-tool-execution-liveness.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readToolStringParam, type AnyAgentTool } from "./common.js";
import { wrapGatewayPersonalToolExecution } from "./gateway-caller-context.js";
import { sendFailure } from "./sessions-send-helpers.js";
import {
  readSessionsSendMessage,
  readSessionsSendMode,
  readSessionsSendTimeout,
} from "./sessions-send-tool.input.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

const SESSIONS_SEND_ADMISSION_TIMEOUT_MS = 30_000;

/** Bound the caller's wait without cancelling input already owned by the receiver. */
export function withSessionsSendDeadline(
  options: SessionsSendToolOptions | undefined,
  execute: (
    opts: SessionsSendToolOptions & { signal: AbortSignal; idempotencyKey: string },
    params: Record<string, unknown>,
    input: {
      message: string;
      mode: ReturnType<typeof readSessionsSendMode>;
      timeoutSeconds: number;
      timeoutMs: number;
      onAdmissionComplete: () => void;
    },
  ) => ReturnType<AnyAgentTool["execute"]>,
): AnyAgentTool["execute"] {
  return wrapGatewayPersonalToolExecution(async (_toolCallId, args, executionSignal) => {
    const params = isRecord(args) ? args : {};
    const message = readSessionsSendMessage(params);
    const mode = readSessionsSendMode(params);
    const timeoutSeconds = readSessionsSendTimeout(params, mode);
    const timeoutMs = finiteSecondsToTimerSafeMilliseconds(timeoutSeconds) ?? 0;
    const overallTimeoutMs = SESSIONS_SEND_ADMISSION_TIMEOUT_MS + timeoutMs;
    const idempotencyKey = options?.idempotencyKey ?? crypto.randomUUID();
    const controller = new AbortController();
    const callerSignal =
      options?.signal && executionSignal
        ? AbortSignal.any([options.signal, executionSignal])
        : (options?.signal ?? executionSignal);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    const admissionComplete = createDeferredCore();
    const timedOut = () => {
      const error =
        "sessions_send timed out; the message may have been accepted. Inspect the target before retrying.";
      controller.abort(new Error(error));
      return sendFailure("error", error, readToolStringParam(params, "sessionKey"), idempotencyKey);
    };
    const releaseDeadline = registerDiagnosticToolExecutionDeadline(Date.now() + overallTimeoutMs);
    try {
      return await raceWithTimeout(
        async () => {
          signal.throwIfAborted();
          const execution = execute({ ...options, idempotencyKey, signal }, params, {
            message,
            mode,
            timeoutSeconds,
            timeoutMs,
            onAdmissionComplete: admissionComplete.resolve,
          });
          // Caller revocation fences new effects but must not hide an accepted receipt.
          const admissionExpired = await raceWithTimeout(
            Promise.race([
              execution.then(() => false),
              admissionComplete.promise.then(() => false),
            ]),
            SESSIONS_SEND_ADMISSION_TIMEOUT_MS,
            () => true,
          );
          return admissionExpired ? timedOut() : await execution;
        },
        overallTimeoutMs,
        timedOut,
      );
    } finally {
      releaseDeadline?.();
    }
  });
}
