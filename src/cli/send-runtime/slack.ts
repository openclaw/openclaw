import { sendMessageSlack as sendMessageSlackImpl } from "../../plugin-sdk/slack.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugin-sdk/slack.js").sendMessageSlack;
};

export const runtimeSend = {
  sendMessage: sendMessageSlackImpl,
} satisfies RuntimeSend;
