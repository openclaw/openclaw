import { getResolvedLoggerSettings } from "../../logging.js";
import { MAX_LOG_STREAM_BYTES, MAX_LOG_STREAM_LIMIT } from "../log-stream.js";
import { readLogSlice, resolveLogFile } from "../log-tail.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateLogsSubscribeParams,
  validateLogsTailParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 250_000;

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export const logsHandlers: GatewayRequestHandlers = {
  "logs.tail": async ({ params, respond }) => {
    if (!validateLogsTailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid logs.tail params: ${formatValidationErrors(validateLogsTailParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { file?: string; cursor?: number; limit?: number; maxBytes?: number };
    const limit = clampPositiveInt(p.limit, DEFAULT_LIMIT, MAX_LOG_STREAM_LIMIT);
    const maxBytes = clampPositiveInt(p.maxBytes, DEFAULT_MAX_BYTES, MAX_LOG_STREAM_BYTES);
    const configuredFile = getResolvedLoggerSettings().file;
    try {
      const file = await resolveLogFile(configuredFile);
      const result = await readLogSlice({
        file,
        previousFile: p.file,
        cursor: p.cursor,
        limit,
        maxBytes,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `log read failed: ${String(err)}`),
      );
    }
  },
  "logs.subscribe": async ({ params, respond, client, context }) => {
    if (!validateLogsSubscribeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid logs.subscribe params: ${formatValidationErrors(validateLogsSubscribeParams.errors)}`,
        ),
      );
      return;
    }

    const connId = client?.connId?.trim();
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "logs.subscribe requires a websocket connection"),
      );
      return;
    }

    const p = params as { file?: string; cursor?: number; limit?: number; maxBytes?: number };
    const limit = clampPositiveInt(p.limit, DEFAULT_LIMIT, MAX_LOG_STREAM_LIMIT);
    const maxBytes = clampPositiveInt(p.maxBytes, DEFAULT_MAX_BYTES, MAX_LOG_STREAM_BYTES);
    const configuredFile = getResolvedLoggerSettings().file;
    try {
      const file = await resolveLogFile(configuredFile);
      const result = await readLogSlice({
        file,
        previousFile: p.file,
        cursor: p.cursor,
        limit,
        maxBytes,
      });
      if (
        !context.subscribeLogEvents(connId, {
          paused: true,
          file,
          cursor: result.cursor,
          limit,
          maxBytes,
        })
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "logs.subscribe could not register the connection"),
        );
        return;
      }
      respond(true, { subscribed: true, file, ...result }, undefined);
      context.activateLogEvents(connId);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `log subscribe failed: ${String(err)}`),
      );
    }
  },
  "logs.unsubscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.unsubscribeLogEvents(connId);
    }
    respond(true, { subscribed: false }, undefined);
  },
};
