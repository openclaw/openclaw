import { sendMessageSlack as sendMessageSlackImpl } from "../../../extensions/slack/runtime-api.js";

type RuntimeSend = {
  sendMessage: typeof import("../../../extensions/slack/runtime-api.js").sendMessageSlack;
};

export const runtimeSend = {
  sendMessage: sendMessageSlackImpl,
} satisfies RuntimeSend;
