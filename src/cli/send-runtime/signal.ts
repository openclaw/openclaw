import { sendMessageSignal as sendMessageSignalImpl } from "../../plugin-sdk/signal.js";

type SendMessageSignal = typeof import("../../plugin-sdk/signal.js").sendMessageSignal;

export async function sendMessageSignal(
  ...args: Parameters<SendMessageSignal>
): ReturnType<SendMessageSignal> {
  return await sendMessageSignalImpl(...args);
}
