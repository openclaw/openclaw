// Shared Gateway error mapping for externally owned config mutation surfaces.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  ManagedConfigMutationError,
  resolveConfigOwnership,
} from "../../config/config-ownership.js";
import type { RespondFn } from "./types.js";

/** Reject external ownership early, before config-coupled handlers mutate other state. */
export function rejectExternallyManagedConfigMutation(respond: RespondFn): boolean {
  const ownership = resolveConfigOwnership();
  // Nix keeps its established mutation error and operator guidance at the config-write boundary.
  if (ownership.mode !== "managed" || ownership.owner !== "external") {
    return false;
  }
  const error = new ManagedConfigMutationError();
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
      retryable: false,
      details: { code: error.code },
    }),
  );
  return true;
}
