import {
  captureOperatorToolGatewayContinuationContext,
  runWithInProcessGatewaySessionMutation,
} from "../../gateway/server-plugin-in-process-dispatch.js";
import type {
  ReplyMessageInjectionOptions,
  ReplyOperation,
} from "../../sessions/session-controller.contracts.js";
import type { SessionControllerSteerResult } from "../../sessions/session-controller.steer.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getControllerEmbeddedAttachment } from "../embedded-agent-runner/run-state.js";
import { captureGatewayToolCallerAssertion } from "./gateway-caller-context.js";

/** The recipient owns accepted input until commit or cancellation, independently of the sender. */
export async function queueSessionsSendSteeringWithCustody(
  target: { sessionKey: string; sessionId: string; agentId: string },
  operation: ReplyOperation,
  assertSelectionCurrent: () => void,
  queue: (
    assertCurrent: () => void,
    lifecycle: Pick<ReplyMessageInjectionOptions, "onQueueAccepted" | "onQueueSettled">,
  ) => Promise<SessionControllerSteerResult>,
): Promise<SessionControllerSteerResult> {
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const custody = await captureOperatorToolGatewayContinuationContext(target);
  if (!custody) {
    throw new Error("Session steering requires in-process caller custody.");
  }
  const admission = createDeferredCore<SessionControllerSteerResult>();
  const settlement = createDeferredCore();
  let accepted = false;
  void (async () => {
    try {
      await custody.run(() =>
        runWithInProcessGatewaySessionMutation(target, async (assertMutationCurrent) => {
          const assertCurrent = () => {
            if (!accepted) {
              assertCallerCurrent?.("sessions.send");
              assertSelectionCurrent();
            }
            assertMutationCurrent();
          };
          assertCurrent();
          const attemptSettlement = getControllerEmbeddedAttachment(operation)?.settlement.promise;
          const queued = queue(assertCurrent, {
            onQueueAccepted: (value) => {
              accepted ||= value;
            },
            onQueueSettled: () => settlement.resolve(),
          });
          void queued.then(
            (outcome) => {
              admission.resolve(outcome);
              if (outcome.status === "rejected") {
                settlement.resolve();
              }
            },
            (error: unknown) => {
              admission.reject(error);
              settlement.resolve();
            },
          );
          // Receiver teardown can precede a backend's queue receipt.
          await (attemptSettlement
            ? Promise.race([settlement.promise, attemptSettlement])
            : settlement.promise);
        }),
      );
    } catch (error) {
      admission.reject(error);
    } finally {
      custody.release();
    }
  })();
  return await admission.promise;
}
