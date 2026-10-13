import { normalizeCommandBody } from "../../auto-reply/commands-registry-normalize.js";
import { parseSlashCommandOrNull } from "../../auto-reply/reply/commands-slash-parse.js";
import { parseConfigCommand } from "../../auto-reply/reply/config-commands.js";
import { parseDebugCommand } from "../../auto-reply/reply/debug-commands.js";
import { logVerbose } from "../../globals.js";
import { getConfigValueAtPath, parseConfigPath, setConfigValueAtPath } from "../config-paths.js";
import { REDACTED_SENTINEL } from "../redact-sentinel.js";
import { appendAssistantMessageToSessionTranscript } from "./transcript.js";

export function scopeCommandTranscriptId(
  messageId: string,
  context: { channelId?: string; accountId?: string; conversationId?: string },
): string;
export function scopeCommandTranscriptId(
  messageId: string | undefined,
  context: { channelId?: string; accountId?: string; conversationId?: string },
): string | undefined;
export function scopeCommandTranscriptId(
  messageId: string | undefined,
  context: { channelId?: string; accountId?: string; conversationId?: string },
): string | undefined {
  return messageId
    ? JSON.stringify([
        context.channelId ?? "",
        context.accountId ?? "",
        context.conversationId ?? "",
        messageId,
      ])
    : undefined;
}

async function redactConfigCommandInput(text: string): Promise<string> {
  const name = parseSlashCommandOrNull(text, "/config") ? "/config" : "/debug";
  const action = parseSlashCommandOrNull(text, name);
  if (action?.action !== "set") {
    return text;
  }
  const command = name === "/config" ? parseConfigCommand(text) : parseDebugCommand(text);
  if (command?.action !== "set") {
    return `${name} set ${REDACTED_SENTINEL}`;
  }
  const path = parseConfigPath(command.path);
  if (!path.ok) {
    return `${name} set ${REDACTED_SENTINEL}`;
  }
  const [{ redactConfigObject }, { loadGatewayRuntimeConfigSchema }] = await Promise.all([
    import("../redact-snapshot.js"),
    import("../runtime-schema.js"),
  ]);
  const preview: Record<string, unknown> = {};
  setConfigValueAtPath(preview, path.path, command.value);
  const redacted = redactConfigObject(preview, loadGatewayRuntimeConfigSchema().uiHints);
  return `${name} set ${command.path}=${JSON.stringify(getConfigValueAtPath(redacted, path.path))}`;
}

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
  const commandText = normalizeCommandBody(params.commandText, {
    targetedCommandMode: "pre-identity",
    preserveArguments: true,
  }).trim();
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
        text: redact(await redactConfigCommandInput(commandText)),
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
