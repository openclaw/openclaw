import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import {
  stopSession,
  type SessionControllerStopCapture,
} from "../../sessions/session-controller.stop.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Retain the caller before an interrupt can change session state. */
export async function prepareChatSendInterruptAdmission(params: {
  operator: Parameters<typeof retainGatewayOperatorRun>[0] &
    Pick<GatewayRequestHandlerOptions, "sessionMutationAuthorization">;
  interruptCapture?: SessionControllerStopCapture;
  entry?: RpcSourceRef;
  assertCurrent?: () => void;
  assertSessionTargetCurrent: () => void;
  abortSignal: AbortSignal;
}) {
  const { sessionMutationAuthorization, ...source } = params.operator;
  const sharing = source.client?.internal?.operatorRunAuthority
    ? undefined
    : sessionMutationAuthorization;
  const invocationAuthority =
    sharing?.retainForRun?.() ??
    (sharing
      ? {
          assertCurrent: sharing.assertAdmittedInputCurrent ?? sharing.assertCurrent,
          release: sharing.retain?.(),
        }
      : undefined);
  let releaseUntransferredSharing = invocationAuthority?.release;
  try {
    const operator = await retainGatewayOperatorRun({
      ...source,
      entry: params.entry,
      invocationAuthority,
    });
    if (operator.authority) {
      releaseUntransferredSharing = undefined;
    }
    const assertCurrent = () => {
      params.assertCurrent?.();
      params.abortSignal.throwIfAborted();
      operator.authority?.assertCurrent();
      if (params.interruptCapture) {
        params.assertSessionTargetCurrent();
      }
    };
    try {
      assertCurrent();
      return {
        operator,
        interrupt: () => {
          assertCurrent();
          if (!params.interruptCapture) {
            return false;
          }
          const interruption = stopSession({
            source: "interrupt",
            capture: params.interruptCapture,
            assertCurrent,
            onError: () => "continue",
          });
          assertCurrent();
          return interruption.aborted || interruption.queuedCancelled > 0;
        },
      };
    } catch (error) {
      operator.release();
      throw error;
    }
  } finally {
    releaseUntransferredSharing?.();
  }
}
