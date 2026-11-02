import {
  ErrorCodes,
  errorShape,
  validateDevicePairCodeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  decideBrowserPairRequest,
  inspectBrowserPairRequest,
} from "../../infra/device-pairing-browser-code.js";
import { normalizeBrowserPairCode } from "../../shared/browser-pair.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { respondUnavailableOnThrow } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const REFUSALS = {
  unknown: "No browser is waiting for this code. Check the code shown in the browser.",
  expired: "This code has expired. Choose Pair this browser again to get a new one.",
  decided: "This code was already answered. Choose Pair this browser again to get a new one.",
} as const;

export const devicePairCodeHandlers: GatewayRequestHandlers = {
  "device.pair.code": defineValidatedGatewayHandler(
    "device.pair.code",
    validateDevicePairCodeParams,
    async (options) => {
      const { params, respond, context } = options;
      await respondUnavailableOnThrow(respond, async () => {
        const { requestId, decision } = params;
        const code = normalizeBrowserPairCode(params.code);
        if (!code || Boolean(requestId) !== Boolean(decision)) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, REFUSALS.unknown));
          return;
        }
        const authority = {
          context: captureOpenClawStateWorkerContext(),
          assertCurrent: readGatewayRequestMutationAuthority(options).assertCurrent,
        };
        const result =
          requestId && decision
            ? await decideBrowserPairRequest({ code, requestId, decision, ...authority })
            : await inspectBrowserPairRequest({ code, ...authority });
        if (!("requestId" in result)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, REFUSALS[result.status]),
          );
          return;
        }
        if (result.status === "approved") {
          context.logGateway.info(`browser pairing approved device=${result.deviceId}`);
        }
        respond(true, result, undefined);
      });
    },
  ),
};
