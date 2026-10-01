import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { onGatewayDeviceSourceRevoked } from "../device-revocation.js";
import {
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
} from "../operator-role-policy.js";
import { WRITE_SCOPE } from "../operator-scopes.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  captureGatewayRequestOperatorGuard,
  readGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** A manual retry keeps this request's write authority until the installer commits. */
export function captureModelsCliCompatibilityRefresh(options: GatewayRequestHandlerOptions): {
  assertCurrent: () => void;
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const assertOperatorCurrent = captureGatewayRequestOperatorGuard(options);
  const authority = readGatewayRequestMutationAuthority(options);
  const assertCurrent = () => {
    signal.throwIfAborted();
    authority.assertCurrent();
    assertOperatorCurrent();
    if (
      (options.client?.connect.role ?? "operator") !== "operator" ||
      !operatorScopeSatisfied(WRITE_SCOPE, options.client?.connect.scopes ?? [])
    ) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Manual CLI compatibility refresh requires operator.write. Reconnect with write access and retry models list --refresh.",
        ),
      );
    }
  };
  assertCurrent();
  const checkCurrent = () => {
    try {
      assertCurrent();
    } catch (error) {
      controller.abort(error);
    }
  };
  const actor = resolveGatewayOperatorRoleActor(options.client);
  const sourceContext = options.context.resolveGatewayContext?.() ?? options.context;
  const releaseDevice = onGatewayDeviceSourceRevoked(
    options.hasCurrentClientAuthority,
    checkCurrent,
  );
  const releasePolicy = onOperatorRolePolicyChanged((change) => {
    if (
      (change.kind === "config" && change.context === sourceContext) ||
      (change.kind === "assignment" &&
        actor?.kind === "operator" &&
        change.profileId === actor.profileId)
    ) {
      checkCurrent();
    }
  });
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    releaseDevice?.();
    releasePolicy();
    controller.abort(new Error("Manual CLI compatibility request finished"));
  };
  try {
    assertCurrent();
  } catch (error) {
    release();
    throw error;
  }
  return { assertCurrent, signal, release };
}
