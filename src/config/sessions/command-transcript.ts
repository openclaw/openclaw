import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeCommandBody } from "../../auto-reply/commands-registry-normalize.js";
import { parseSlashCommandOrNull } from "../../auto-reply/reply/commands-slash-parse.js";
import { parseConfigCommand } from "../../auto-reply/reply/config-commands.js";
import { parseDebugCommand } from "../../auto-reply/reply/debug-commands.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.registry.js";
import {
  getReplyOperationSessionTarget,
  hasReplyOperationExecutionStarted,
  waitForReplyBarrierSettlement,
} from "../../auto-reply/reply/reply-run-registry.state.js";
import { logVerbose } from "../../globals.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getConfigValueAtPath, parseConfigPath, setConfigValueAtPath } from "../config-paths.js";
import { REDACTED_SENTINEL } from "../redact-sentinel.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { prepareSqliteScope } from "./session-accessor.sqlite-scope.js";
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

type CommandExchangeParams = Pick<
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
};

/** Records only settled command output; callers must first confirm delivery. */
export function recordDeliveredCommandExchange(params: CommandExchangeParams) {
  return recordDeliveredCommandExchangeCore(params, false);
}

/** Fast Stop's own admission ticket waits for the exchange, not just delivery. */
export function recordDeliveredStopExchange(params: CommandExchangeParams) {
  return waitForReplyBarrierSettlement(recordDeliveredCommandExchangeCore(params, true));
}

const MAX_COMMAND_SETTLEMENT_WAITS = 8;

async function resolveCommandBlockingRun(params: CommandExchangeParams) {
  if (params.expectedWriterRunId) {
    // The command is coordinated with the writer itself.
    return undefined;
  }
  const directKey = params.sessionKey.trim();
  const agentId =
    params.agentId?.trim() ||
    resolveAgentIdFromSessionKey(
      directKey,
      params.config ? resolveDefaultAgentId(params.config) : undefined,
    );
  const sessionKey = resolveSqliteSessionKey(directKey, agentId);
  const findStartedRun = () => {
    const run = replyRunRegistry.get(sessionKey) ?? replyRunRegistry.get(directKey);
    return run &&
      !run.abortSignal.aborted &&
      (!params.expectedSessionId || run.sessionId === params.expectedSessionId) &&
      (run.phase === "running" || hasReplyOperationExecutionStarted(run))
      ? run
      : undefined;
  };
  const active = findStartedRun();
  if (!active) {
    return undefined;
  }
  const activeTarget = getReplyOperationSessionTarget(active);
  // Unscoped reply owners can only be matched by an already captured session ID.
  if (!activeTarget) {
    return params.expectedSessionId ? findStartedRun : undefined;
  }
  const storePath =
    params.storePath ?? resolveSessionStorePathCore(params.config?.session?.store, { agentId });
  const target = await prepareSqliteScope({ storePath, sessionKey, agentId });
  return () => {
    const run = findStartedRun();
    return run && getReplyOperationSessionTarget(run)?.storePath === target.path ? run : undefined;
  };
}

async function recordDeliveredCommandExchangeCore(
  params: CommandExchangeParams,
  waitForSettlement: boolean,
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
    const append = {
      ...params,
      text: redact(params.replyText),
      command: {
        text: redact(await redactConfigCommandInput(commandText)),
        idempotencyKey: `command-input:${params.commandId}`,
      },
      idempotencyKey: `command-reply:${params.commandId}:${params.replyId}`,
    };
    const findBlockingRun = await resolveCommandBlockingRun(params);
    const blockingRun = findBlockingRun?.();
    if (!blockingRun || !findBlockingRun) {
      return await appendAssistantMessageToSessionTranscript(append);
    }
    // A command exchange modifies the prepared replay context. Let its exact
    // turn owner finish first without holding an ordinary command dispatcher open.
    const deferred = (async () => {
      let active = blockingRun;
      for (let attempt = 0; attempt < MAX_COMMAND_SETTLEMENT_WAITS; attempt += 1) {
        await active.ownerSettlement;
        const successor = findBlockingRun();
        if (!successor) {
          return await appendAssistantMessageToSessionTranscript({
            ...append,
            expectedSessionId: params.expectedSessionId ?? blockingRun.sessionId,
          });
        }
        active = successor;
      }
      logVerbose("Command transcript recording skipped: session stayed busy after delivery");
      return { ok: false as const, reason: "session stayed busy" };
    })();
    if (waitForSettlement) {
      return await deferred;
    }
    void deferred.catch(() => logVerbose("Command transcript recording failed after delivery"));
    return { ok: false as const, reason: "deferred until the active turn settles" };
  } catch {
    // Delivery has already succeeded. A transcript failure must not trigger a resend.
    logVerbose("Command transcript recording failed after delivery");
    return { ok: false as const, reason: "transcript recording failed" };
  }
}
