import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import {
  stopSession,
  type SessionControllerStopCapture,
} from "../../sessions/session-controller.stop.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";

/** Retain the caller before an interrupt can change session state. */
export async function prepareChatSendInterruptAdmission(params: {
  operator: Parameters<typeof retainGatewayOperatorRun>[0];
  interruptCapture?: SessionControllerStopCapture;
  entry?: RpcSourceRef;
  assertCurrent?: () => void;
  assertSessionTargetCurrent: () => void;
  abortSignal: AbortSignal;
}) {
  const operator = await retainGatewayOperatorRun({ ...params.operator, entry: params.entry });
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
}
