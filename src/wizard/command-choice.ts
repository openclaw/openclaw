import type { ReplyPayload } from "../auto-reply/types.js";
import type { MessagePresentationButton } from "../interactive/payload.js";

export function buildCommandChoiceReply(
  message: string,
  buttons: Array<MessagePresentationButton & { action: { type: "command"; command: string } }>,
): ReplyPayload & { text: string } {
  return {
    text: [
      message,
      ...buttons.map((button) => `${button.label}: \`${button.action.command}\``),
    ].join("\n"),
    presentationTextMode: "fallback",
    presentation: {
      blocks: [
        { type: "text", text: message },
        { type: "buttons", buttons },
      ],
    },
  };
}
