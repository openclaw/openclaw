import {
  captureOperatorToolGatewayContinuationContext,
  runWithInProcessGatewaySessionMutation,
} from "../../gateway/server-plugin-in-process-dispatch.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageOutcome,
} from "../embedded-agent-runner/runs.js";
import { captureGatewayToolCallerAssertion } from "./gateway-caller-context.js";

/** The recipient owns accepted input until commit or cancellation, independently of the sender. */
export async function queueSessionsSendSteeringWithCustody(
  target: { sessionKey: string; agentId: string },
  assertSelectionCurrent: () => void,
  queue: (
    assertCurrent: () => void,
    lifecycle: Pick<EmbeddedAgentQueueMessageOptions, "onQueueAccepted" | "onQueueSettled">,
  ) => Promise<EmbeddedAgentQueueMessageOutcome>,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const custody = await captureOperatorToolGatewayContinuationContext(target);
  if (!custody) {
    throw new Error("Session steering requires in-process caller custody.");
  }
  const admission = createDeferredCore<EmbeddedAgentQueueMessageOutcome>();
  const settlement = createDeferredCore();
  let accepted = false;
  void (async () => {
    try {
      await custody.run(() =>
        runWithInProcessGatewaySessionMutation("agent", target, async (assertMutationCurrent) => {
          const assertCurrent = () => {
            if (!accepted) {
              assertCallerCurrent?.("agent");
              assertSelectionCurrent();
            }
            assertMutationCurrent();
          };
          assertCurrent();
          const queued = queue(assertCurrent, {
            onQueueAccepted: (value) => {
              accepted ||= value;
            },
            onQueueSettled: () => settlement.resolve(),
          });
          void queued.then(
            (outcome) => {
              admission.resolve(outcome);
              if (!outcome.queued) {
                settlement.resolve();
              }
            },
            (error: unknown) => {
              admission.reject(error);
              settlement.resolve();
            },
          );
          // Receiver teardown can precede a backend's queue receipt.
          await settlement.promise;
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
