import { sendMessageSlack as sendMessageSlackImpl } from "../../plugin-sdk/slack.js";

type SendMessageSlack = typeof import("../../plugin-sdk/slack.js").sendMessageSlack;

export async function sendMessageSlack(
  ...args: Parameters<SendMessageSlack>
): ReturnType<SendMessageSlack> {
  return await sendMessageSlackImpl(...args);
}
