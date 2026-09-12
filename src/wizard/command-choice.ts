import { randomBytes } from "node:crypto";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { MessagePresentationButton } from "../interactive/payload.js";
import type { WizardSelectParams } from "./prompts.js";

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

/** Use only provider identity; Telegram callbacks have a 64-byte limit (2026-09-11). */
export function createLoginChoicePrompt<T>(
  prompt: WizardSelectParams<T>,
  signal: AbortSignal,
  provider: string,
) {
  const id = randomBytes(8).toString("hex");
  let answered = false;
  return {
    reply: buildCommandChoiceReply(
      prompt.message,
      prompt.options.map((option, index) => ({
        label: option.label,
        action: { type: "command", command: `/login choice ${id} ${index} ${provider}` },
      })),
    ),
    answer(command: string): { value: T } | undefined {
      const match = /^\/login choice ([a-f0-9]+) (\d+) (\S+)$/u.exec(command.trim());
      if (!match || answered || signal.aborted || match[1] !== id || match[3] !== provider) {
        return undefined;
      }
      const index = Number(match[2]);
      const option = Number.isSafeInteger(index) ? prompt.options[index] : undefined;
      if (!option) {
        return undefined;
      }
      answered = true;
      return { value: option.value };
    },
  };
}
