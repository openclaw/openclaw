import { sendMessageSignal as sendMessageSignalImpl } from "openclaw/plugin-sdk/signal";

type RuntimeSend = {
  sendMessage: typeof import("openclaw/plugin-sdk/signal").sendMessageSignal;
};

export const runtimeSend = {
  sendMessage: sendMessageSignalImpl,
} satisfies RuntimeSend;
