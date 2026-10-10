import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  applyConfigStateMutation,
  configStateMutationSchema,
} from "../../config/config-state-mutation.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import { errorShapeFromError } from "../error-shape.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import type { GatewayRequestHandler } from "./types.js";

const paramsSchema = z.strictObject({
  expectedOwnerId: z.string().min(1),
  mutation: configStateMutationSchema,
});

export const configStateMutationHandler: GatewayRequestHandler = async (options) => {
  const parsed = paramsSchema.safeParse(options.params);
  if (!parsed.success) {
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Invalid config state mutation", {
        details: { mutationAccepted: false },
      }),
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
    const written = await applyConfigStateMutation(
      parsed.data.mutation,
      process.env,
      assertCurrent,
    );
    assertCurrent();
    options.respond(true, written, undefined);
  } catch (error) {
    options.respond(
      false,
      undefined,
      errorShapeFromError(ErrorCodes.UNAVAILABLE, error, {
        details: {
          configStateError: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
        },
        retryable: false,
      }),
    );
  }
};
