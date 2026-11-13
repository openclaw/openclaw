import {
  ErrorCodes,
  errorShape,
  validateLogsTailParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readConfiguredLogTailInWorker } from "../../logging/log-tail-worker.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const logsHandlers: GatewayRequestHandlers = {
  "logs.tail": defineValidatedGatewayMethod(
    "logs.tail",
    validateLogsTailParams,
    async ({ params, respond }) => {
      respond(true, await readConfiguredLogTailInWorker(params), undefined);
    },
    (err) => errorShape(ErrorCodes.UNAVAILABLE, `log read failed: ${String(err)}`),
  ),
};
