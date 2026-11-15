import { logDebug } from "../logger.js";
import type { BoundedBuffer } from "../shared/bounded-buffer.js";

export type NodeInvokeInputTarget = {
  nextInputSeq: number;
  input?: (payloadJSON: string) => void;
  // Buffer spawn-window input so its sequence cannot wedge before PTY registration.
  pendingInput: BoundedBuffer<string>;
  inputFailed: boolean;
};

export function dispatchNodeInvokeInput(
  target: NodeInvokeInputTarget | undefined,
  seq: number,
  payloadJSON: string,
): boolean {
  if (!target || target.inputFailed || seq < target.nextInputSeq) {
    return false;
  }
  if (seq > target.nextInputSeq) {
    logDebug(`node-host: input sequence gap: expected ${target.nextInputSeq}, received ${seq}`);
  }
  target.nextInputSeq = seq + 1;
  if (target.input) {
    target.input(payloadJSON);
    return true;
  }
  if (!target.pendingInput.push(payloadJSON)) {
    target.inputFailed = true;
    logDebug("node-host: aborted invoke after buffered input exceeded 64 KiB");
    return false;
  }
  return true;
}

export function registerNodeInvokeInputHandler(
  target: NodeInvokeInputTarget,
  input: (payloadJSON: string) => void,
): void {
  if (target.inputFailed) {
    return;
  }
  target.input = input;
  for (const pending of target.pendingInput.drain()) {
    input(pending);
  }
}
