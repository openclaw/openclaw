import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { AcpDispatchDeliveryParams } from "./dispatch-acp-delivery.types.js";

export function createAcpReplyLifecycle(
  params: Pick<
    AcpDispatchDeliveryParams,
    "suppressReplyLifecycle" | "onReplyStart" | "onVisibleDeliveryStart"
  >,
) {
  let started = false;
  const startReplyLifecycleOnce = async () => {
    // Suppressed generic lifecycle must not consume the visible-delivery start
    // slot; routed delivery may still start typing at the exact send point.
    if (params.suppressReplyLifecycle) {
      return;
    }
    if (started) {
      return;
    }
    started = true;
    void Promise.resolve(params.onReplyStart?.()).catch((error: unknown) => {
      logVerbose(`dispatch-acp: reply lifecycle start failed: ${formatErrorMessage(error)}`);
    });
  };
  const startVisibleDeliveryOnce = async () => {
    if (!params.onVisibleDeliveryStart) {
      return;
    }
    if (started) {
      return;
    }
    started = true;
    await params.onVisibleDeliveryStart();
  };

  return { startReplyLifecycleOnce, startVisibleDeliveryOnce };
}
