import { createSubsystemLogger } from "../../logging/subsystem.js";
import { registerSignalExitOwner } from "../signal-exit-barrier.js";

/** The launching host retains the write end of stdin for this process's lifetime. */
export function installGatewayHostLifeline(onHostExit: () => void): (() => void) | undefined {
  const lifeline = process.env.OPENCLAW_GATEWAY_HOST_LIFELINE?.trim();
  if (!lifeline) {
    return undefined;
  }
  const logger = createSubsystemLogger("gateway");
  if (lifeline !== "stdin") {
    logger.warn("Ignoring unsupported OPENCLAW_GATEWAY_HOST_LIFELINE; expected stdin");
    return undefined;
  }
  const input = process.stdin;
  let stopped = false;
  const stopInput = () => {
    stopped = true;
    input.removeListener("end", inputClosed);
    input.removeListener("error", inputClosed);
    input.removeListener("close", inputClosed);
    input.pause();
  };
  const hostExited = (reason: string) => {
    if (stopped) {
      return;
    }
    stopInput();
    logger.info(`Gateway host exited (${reason}); shutting down`);
    onHostExit();
  };
  const inputClosed = () => hostExited("stdin lifeline closed");
  const releaseExitOwner = registerSignalExitOwner((code) => {
    // A successful drain must not erase a failure already reported by the output owner.
    if (Number(code) !== 0 && Number(process.exitCode ?? 0) === 0) {
      process.exitCode = Number(code);
    }
    hostExited("output pipe closed");
  });
  input.once("end", inputClosed);
  input.once("error", inputClosed);
  input.once("close", inputClosed);
  if (input.readableEnded || input.destroyed) {
    queueMicrotask(inputClosed);
  } else {
    input.resume();
  }
  return () => {
    stopInput();
    releaseExitOwner();
  };
}
