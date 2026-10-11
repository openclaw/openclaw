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
      /\b((?:device|pairing|verification|login|setup)\s+code|code)\s*:\s*(?:<code>)?[^\s<]+(?:<\/code>)?/gi,
      "$1: [login code redacted]",
    );
    const withoutPairingPayload = /^\/pair(?:@\S+)?(?:\s|$)/i.test(commandText)
      ? withoutCodes.replace(/\beyJ[A-Za-z0-9_-]{32,}={0,2}\b/g, "[pairing code redacted]")
      : withoutCodes;
    return withoutPairingPayload.replace(/https?:\/\/[^\s<>]+/gi, (url) =>
      /^\/login(?:@\S+)?(?:\s|$)/i.test(commandText) ||
      /[?&](?:[\w-]*token|state|code|user_code|device_code|secret|key)=/i.test(url)
        ? "[login URL redacted]"
        : url,
    );
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
