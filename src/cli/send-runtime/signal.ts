import { sendMessageSignal as sendMessageSignalImpl } from "../../plugin-sdk/signal.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugin-sdk/signal.js").sendMessageSignal;
};

export const runtimeSend = {
  sendMessage: sendMessageSignalImpl,
} satisfies RuntimeSend;
