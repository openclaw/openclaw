import { readConfiguredLogTail } from "../../logging/log-tail.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateLogsSubscribeParams,
  validateLogsTailParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

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

    const p = params as { cursor?: number; limit?: number; maxBytes?: number };
    try {
      const result = await readConfiguredLogTail({
        cursor: p.cursor,
        limit: p.limit,
        maxBytes: p.maxBytes,
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

    if (!context.subscribeLogEvents(connId, { paused: true })) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "logs.subscribe could not register the connection"),
      );
      return;
    }

    const p = params as { cursor?: number; limit?: number; maxBytes?: number };
    const configuredFile = getResolvedLoggerSettings().file;
    try {
      const file = await resolveLogFile(configuredFile);
      const result = await readLogSlice({
        file,
        cursor: p.cursor,
        limit: p.limit ?? DEFAULT_LIMIT,
        maxBytes: p.maxBytes ?? DEFAULT_MAX_BYTES,
      });
      respond(true, { subscribed: true, file, ...result }, undefined);
      context.activateLogEvents(connId);
    } catch (err) {
      context.unsubscribeLogEvents(connId);
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
