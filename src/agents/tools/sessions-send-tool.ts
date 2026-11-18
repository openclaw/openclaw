import crypto from "node:crypto";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import { getRuntimeConfig } from "../../config/config.js";
import { registerDiagnosticToolExecutionDeadline } from "../../infra/diagnostic-tool-execution-liveness.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { wrapGatewayPersonalToolExecution } from "./gateway-caller-context.js";
import {
  PlacedSessionsSendSchema,
  PLACED_SESSIONS_SEND_DESCRIPTION,
} from "./sessions-placement-tool-contract.js";
import { executeSessionsSend } from "./sessions-send-executor.js";
import { sendFailure } from "./sessions-send-helpers.js";
import { createSelfHeldSendRetainer } from "./sessions-send-self-hold.js";
import { withSessionsSendRequesterSource } from "./sessions-send-session-source.js";
import {
  readSessionsSendMode,
  readSessionsSendTimeout,
  readSessionsSendTarget,
} from "./sessions-send-tool.input.js";
import { SessionsSendToolSchema, SessionsSendOutputSchema } from "./sessions-send-tool.schema.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";

export function createSessionsSendTool(opts?: SessionsSendToolOptions): AnyAgentTool {
  const retain = createSelfHeldSendRetainer(opts, (options, args) =>
    executeSessionsSendWithDeadline(options, "retained", args),
  );
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: opts?.workerPlacement
      ? PLACED_SESSIONS_SEND_DESCRIPTION
      : describeSessionsSendTool({
          allowThreadTargets:
            (opts?.config ?? getRuntimeConfig()).tools?.sessions?.allowThreadTargets === true,
        }),
    parameters: opts?.workerPlacement ? PlacedSessionsSendSchema : SessionsSendToolSchema,
    outputSchema: SessionsSendOutputSchema,
    execute: wrapGatewayPersonalToolExecution((toolCallId, args) =>
      executeSessionsSendWithDeadline(opts, toolCallId, args, retain),
    ),
  };
}

/** One send implementation, shared by direct execution and the one-shot retained replay. */
async function executeSessionsSendWithDeadline(
  opts: SessionsSendToolOptions | undefined,
  toolCallId: string,
  args: unknown,
  retain?: ReturnType<typeof createSelfHeldSendRetainer>,
) {
  const params = isRecord(args) ? args : {};
  const mode = readSessionsSendMode(params);
  const timeoutSeconds = readSessionsSendTimeout(params, mode);
  const timeoutMs =
    finiteSecondsToTimerSafeMilliseconds(timeoutSeconds === 0 ? 30 : timeoutSeconds) ?? 30_000;
  const runId = opts?.idempotencyKey ?? crypto.randomUUID();
  const controller = new AbortController();
  const signal = opts?.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  const boundedOptions: SessionsSendToolOptions = {
    ...opts,
    idempotencyKey: runId,
    signal,
    assertSourceCurrent: () => {
      signal.throwIfAborted();
      opts?.assertSourceCurrent?.();
    },
  };
  const deadlineAtMs = Date.now() + timeoutMs;
  const releaseDeadline = registerDiagnosticToolExecutionDeadline(deadlineAtMs);
  try {
    return await raceWithTimeout(
      () =>
        withSessionsSendRequesterSource(boundedOptions, () =>
          executeSessionsSend(
            boundedOptions,
            toolCallId,
            { params, mode, timeoutSeconds, deadlineAtMs },
            retain,
          ),
        ),
      timeoutMs,
      () => {
        const error =
          "sessions_send timed out; the message may have been accepted. Inspect the target before retrying.";
        // Stop new sender effects without cancelling input already owned by the receiver.
        controller.abort(new Error(error));
        const target = readSessionsSendTarget(params);
        return sendFailure("timeout", error, target.ok ? target.sessionKeyParam : undefined, runId);
      },
      { signal: opts?.signal },
    );
  } finally {
    releaseDeadline?.();
  }
}
