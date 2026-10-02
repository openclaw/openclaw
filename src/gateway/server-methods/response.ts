import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { errorShapeFromError } from "../error-shape.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import type { RespondFn } from "./types.js";

export function respondUnavailable(respond: RespondFn, err: unknown): void {
  respond(false, undefined, errorShapeFromError(ErrorCodes.UNAVAILABLE, err));
}

export async function respondUnavailableOnThrow(respond: RespondFn, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SessionMutationAuthorizationChangedError) {
      throw err;
    }
    respondUnavailable(respond, err);
  }
}
