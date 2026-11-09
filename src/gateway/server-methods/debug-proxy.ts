import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { debugProxyCliCommandSchema } from "../../proxy-capture/cli-contract.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import type { GatewayRequestHandlers } from "./types.js";

const requestSchema = z
  .object({
    expectedOwnerId: z.string().min(1),
    command: debugProxyCliCommandSchema,
  })
  .strict();

export const debugProxyHandlers: GatewayRequestHandlers = {
  "debugProxy.capture": async (options) => {
    const parsed = requestSchema.safeParse(options.params);
    if (!parsed.success) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, parsed.error.message),
      );
      return;
    }
    let assertCurrent: () => void;
    try {
      assertCurrent = captureLocalStateMutationGuard(parsed.data.expectedOwnerId, options);
    } catch (error) {
      options.respond(false, undefined, localStateOwnerChangedError(error));
      return;
    }
    try {
      const result = await runOpenClawStateWorkerOperation(
        captureOpenClawStateWorkerContext(),
        (scope) =>
          scope.execute({ type: parsed.data.command.type, input: parsed.data.command.input }),
        { assertCurrent, signal: options.signal },
      );
      options.respond(true, result ?? null);
    } catch (error) {
      options.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
    }
  },
};
