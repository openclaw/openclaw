import { sendMessageSignal as sendMessageSignalImpl } from "../../../extensions/signal/runtime-api.js";

type RuntimeSend = {
  sendMessage: typeof import("../../../extensions/signal/runtime-api.js").sendMessageSignal;
};

export const runtimeSend = {
  sendMessage: sendMessageSignalImpl,
} satisfies RuntimeSend;
