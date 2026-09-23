import {
  publishVitestResourceContext,
  resolveVitestResourceContext,
  VITEST_PAUSE_AFTER_ACK_RECEIPT,
} from "./vitest-resource-context.test-support.ts";

publishVitestResourceContext(resolveVitestResourceContext(process.env));
const pauseAfterAckReceipt = process.env[VITEST_PAUSE_AFTER_ACK_RECEIPT];
if (pauseAfterAckReceipt && process.platform !== "win32") {
  const { default: installPauseAfterAcknowledgementProbe } =
    await import("./vitest-resource-stop-probe.test-support.mjs");
  installPauseAfterAcknowledgementProbe(pauseAfterAckReceipt);
}
