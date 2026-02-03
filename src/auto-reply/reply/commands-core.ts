import crypto from "node:crypto";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleApproveCommand } from "./commands-approve.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import {
  handleCommandsListCommand,
  handleContextCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleWhoamiCommand,
} from "./commands-info.js";
import { handleModelsCommand } from "./commands-models.js";
import { handlePluginCommand } from "./commands-plugin.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleRestartCommand,
  handleSendPolicyCommand,
  handleStopCommand,
  handleUsageCommand,
} from "./commands-session.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleTtsCommands } from "./commands-tts.js";
import { routeReply } from "./route-reply.js";

let HANDLERS: CommandHandler[] | null = null;

export async function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult> {
  if (HANDLERS === null) {
    HANDLERS = [
      // Plugin commands are processed first, before built-in commands
      handlePluginCommand,
      handleBashCommand,
      handleActivationCommand,
      handleSendPolicyCommand,
      handleUsageCommand,
      handleRestartCommand,
      handleTtsCommands,
      handleHelpCommand,
      handleCommandsListCommand,
      handleStatusCommand,
      handleAllowlistCommand,
      handleApproveCommand,
      handleContextCommand,
      handleWhoamiCommand,
      handleSubagentsCommand,
      handleConfigCommand,
      handleDebugCommand,
      handleModelsCommand,
      handleStopCommand,
      handleCompactCommand,
      handleAbortTrigger,
    ];
  }
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
  const resetRequested = Boolean(resetMatch);
  if (resetRequested && !params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Trigger internal hook for reset/new commands
  if (resetRequested && params.command.isAuthorizedSender) {
    const commandAction = resetMatch?.[1] ?? "new";
    // Use stable fallback key for non-persisted flows so command hooks always fire
    // Hash From/To/AccountId/ThreadId to avoid PII and prevent collisions across accounts/threads
    const fallbackKey = params.sessionKey
      ? null
      : `command:${params.ctx.Provider || "unknown"}:${crypto
          .createHash("sha256")
          .update(
            `${params.ctx.From || ""}:${params.ctx.To || ""}:${params.ctx.AccountId || ""}:${params.ctx.MessageThreadId || ""}`,
          )
          .digest("hex")
          .slice(0, 16)}`;
    const hookSessionKey = params.sessionKey || fallbackKey || "command:unknown";
    let hookMessages: string[] = [];
    // Guard each clone individually for best-effort hook context
    let clonedSessionEntry: typeof params.sessionEntry | undefined;
    if (params.sessionEntry) {
      try {
        clonedSessionEntry = structuredClone(params.sessionEntry);
      } catch {
        clonedSessionEntry = undefined;
      }
    }
    let clonedPreviousEntry: typeof params.previousSessionEntry | undefined;
    if (params.previousSessionEntry) {
      try {
        clonedPreviousEntry = structuredClone(params.previousSessionEntry);
      } catch {
        clonedPreviousEntry = undefined;
      }
    }
    try {
      const hookEvent = createInternalHookEvent("command", commandAction, hookSessionKey, {
        sessionEntry: clonedSessionEntry,
        previousSessionEntry: clonedPreviousEntry,
        commandSource: params.command.surface,
        senderId: params.command.senderId,
      });
      await triggerInternalHook(hookEvent);
      hookMessages = hookEvent.messages;
    } catch (err) {
      defaultRuntime.error(`command:${commandAction} hook failed: ${String(err)}`);
    }

    // Send hook messages immediately if present
    if (hookMessages.length > 0) {
      // Use OriginatingChannel if available, otherwise fall back to command channel
      // oxlint-disable-next-line typescript/no-explicit-any
      const channel = params.ctx.OriginatingChannel || (params.command.channel as any);
      // Use same addressing logic as normal reply path (get-reply-run.ts:293)
      const to = params.ctx.OriginatingTo || params.command.from || params.command.to;

      if (channel && to) {
        try {
          const hookReply = { text: hookMessages.join("\n\n") };
          await routeReply({
            payload: hookReply,
            channel: channel,
            to: to,
            // Use real session key (may be undefined in non-persisted flows)
            // Hook message delivery is best-effort; messages may not persist without a session key
            sessionKey: params.sessionKey,
            accountId: params.ctx.AccountId,
            threadId: params.ctx.MessageThreadId,
            cfg: params.cfg,
          });
        } catch (err) {
          defaultRuntime.error(
            `Failed to deliver hook messages for ${commandAction}: ${String(err)}`,
          );
        }
      } else {
        logVerbose(
          `Hook messages for ${commandAction} dropped: missing ${!channel ? "channel" : "to"} (hook output is best-effort depending on routing context)`,
        );
      }
    }
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: params.command.surface,
    commandSource: params.ctx.CommandSource,
  });

  for (const handler of HANDLERS) {
    const result = await handler(params, allowTextCommands);
    if (result) {
      return result;
    }
  }

  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
    channel: params.sessionEntry?.channel ?? params.command.channel,
    chatType: params.sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${params.sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }

  return { shouldContinue: true };
}
