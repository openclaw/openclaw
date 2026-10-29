import type { MsgContext } from "../templating.js";

export function nativeGroupContext(provider: string, from: string, senderId: string): MsgContext {
  return {
    Provider: provider,
    Surface: provider,
    ChatType: "group",
    From: from,
    SenderId: senderId,
    CommandSource: "native",
  };
}
