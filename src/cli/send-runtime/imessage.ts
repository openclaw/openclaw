import { sendMessageIMessage as sendMessageIMessageImpl } from "../../plugin-sdk/imessage.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugin-sdk/imessage.js").sendMessageIMessage;
};

export const runtimeSend = {
  sendMessage: sendMessageIMessageImpl,
} satisfies RuntimeSend;
