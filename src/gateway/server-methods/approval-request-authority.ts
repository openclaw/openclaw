import { assertionSucceeds } from "../../shared/assertion.js";
import type { OperatorApprovalStoreGuard } from "../operator-approval-store.types.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Retain the original invocation; copying options loses its request-owner binding. */
export function createApprovalRequestAuthority(options: GatewayRequestHandlerOptions) {
  const authority = readGatewayRequestMutationAuthority(options);
  let closed = false;
  const assertCurrent = () => {
    authority.assertCurrent();
    authority.expectedProfileBinding?.assertCurrent();
    if (closed) {
      throw new Error("The approval request ended. Start a new request to retry.");
    }
  };
  const guard: OperatorApprovalStoreGuard = {
    family: authority.family,
    assertCurrent:
      authority.family === "native-compatibility"
        ? assertCurrent
        : () => {
            authority.assertWorkerCurrent();
            authority.expectedProfileBinding?.assertCurrent();
            if (closed) {
              throw new Error("The approval request ended. Start a new request to retry.");
            }
          },
  };
  return {
    guard,
    assertCurrent,
    assertCommitCurrent: guard.assertCurrent,
    isCurrent: () => assertionSucceeds(assertCurrent),
    [Symbol.dispose]() {
      closed = true;
    },
  };
}

export type ApprovalRequestAuthority = ReturnType<typeof createApprovalRequestAuthority>;
