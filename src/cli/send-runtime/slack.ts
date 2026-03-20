import { sendMessageSlack as sendMessageSlackImpl } from "openclaw/plugin-sdk/slack";

type RuntimeSend = {
  sendMessage: typeof import("openclaw/plugin-sdk/slack").sendMessageSlack;
};

export const runtimeSend = {
  sendMessage: sendMessageSlackImpl,
} satisfies RuntimeSend;
