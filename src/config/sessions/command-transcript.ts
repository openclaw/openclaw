import { logVerbose } from "../../globals.js";
import { appendAssistantMessageToSessionTranscript } from "./transcript.js";

/** Records only settled command output; callers must first confirm delivery. */
export async function recordDeliveredCommandExchange(
  params: Pick<
    Parameters<typeof appendAssistantMessageToSessionTranscript>[0],
    | "agentId"
    | "sessionKey"
    | "expectedSessionId"
    | "expectedLifecycleRevision"
    | "expectedWriterRunId"
    | "storePath"
    | "config"
    | "assertCurrent"
    | "beforeMessageWrite"
  > & {
    commandText: string;
    replyText: string;
    commandId: string;
    replyId: string;
  },
) {
  const commandText = params.commandText.trim();
  if (/^\/(?:btw|side)(?:@\S+)?(?:\s|$)/i.test(commandText)) {
    return { ok: false as const, reason: "ephemeral command" };
  }
  const redact = (text: string) => {
    const withoutCodes = text.replace(
      /\b((?:device|pairing|verification|login)\s+code|code)\s*:\s*(?:<code>)?[^\s<]+(?:<\/code>)?/gi,
      "$1: [login code redacted]",
    );
    return /^\/login(?:@\S+)?(?:\s|$)/i.test(commandText)
      ? withoutCodes.replace(/https?:\/\/[^\s<>]+/gi, "[login URL redacted]")
      : withoutCodes;
  };
  try {
    return await appendAssistantMessageToSessionTranscript({
      ...params,
      text: redact(params.replyText),
      command: {
        text: redact(commandText),
        idempotencyKey: `command-input:${params.commandId}`,
      },
      idempotencyKey: `command-reply:${params.commandId}:${params.replyId}`,
    });
  } catch {
    // Delivery has already succeeded. A transcript failure must not trigger a resend.
    logVerbose("Command transcript recording failed after delivery");
    return { ok: false as const, reason: "transcript recording failed" };
  }
}
