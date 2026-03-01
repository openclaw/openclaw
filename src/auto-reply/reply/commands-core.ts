import fs from "node:fs/promises";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
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
  handleExportSessionCommand,
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
  handleSessionCommand,
  handleSendPolicyCommand,
  handleStopCommand,
  handleUsageCommand,
} from "./commands-session.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleTtsCommands } from "./commands-tts.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { routeReply } from "./route-reply.js";

// ---------------------------------------------------------------------------
// Reset command hook helpers
// ---------------------------------------------------------------------------

/**
 * The action that triggered a /new or /reset command.
 */
export type ResetCommandAction = "reset" | "new";

type EmitResetCommandHooksParams = Pick<
  HandleCommandsParams,
  | "ctx"
  | "cfg"
  | "command"
  | "sessionKey"
  | "sessionEntry"
  | "previousSessionEntry"
  | "workspaceDir"
> & { action: ResetCommandAction };

/**
 * Emit internal and plugin hooks for a /new or /reset command.
 *
 * Extracted so that `getReplyFromConfig` can fire these hooks for cases where
 * the command was processed outside the normal `handleCommands` path (e.g. when
 * the directive flow handled the reset before commands were evaluated).
 */
export async function emitResetCommandHooks(params: EmitResetCommandHooksParams): Promise<void> {
  const commandAction = params.action;

  const hookEvent = createInternalHookEvent("command", commandAction, params.sessionKey ?? "", {
    sessionEntry: params.sessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    commandSource: params.command.surface,
    senderId: params.command.senderId,
    cfg: params.cfg,
  });
  await triggerInternalHook(hookEvent);

  // Send hook messages immediately if present
  if (hookEvent.messages.length > 0) {
    // Use OriginatingChannel/To if available, otherwise fall back to command channel/from
    // oxlint-disable-next-line typescript/no-explicit-any
    const channel = params.ctx.OriginatingChannel || (params.command.channel as any);
    // For replies, use 'from' (the sender) not 'to' (which might be the bot itself)
    const to = params.ctx.OriginatingTo || params.command.from || params.command.to;

    if (channel && to) {
      const hookReply = { text: hookEvent.messages.join("\n\n") };
      await routeReply({
        payload: hookReply,
        channel: channel,
        to: to,
        sessionKey: params.sessionKey,
        accountId: params.ctx.AccountId,
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
      });
    }
  }

  // Fire before_reset plugin hook — extract memories before session history is lost
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_reset")) {
    const prevEntry = params.previousSessionEntry;
    const sessionFile = prevEntry?.sessionFile;
    // Fire-and-forget: read old session messages and run hook
    void (async () => {
      try {
        const messages: unknown[] = [];
        if (sessionFile) {
          const content = await fs.readFile(sessionFile, "utf-8");
          for (const line of content.split("\n")) {
            if (!line.trim()) {
              continue;
            }
            try {
              const entry = JSON.parse(line);
              if (entry.type === "message" && entry.message) {
                messages.push(entry.message);
              }
            } catch {
              // skip malformed lines
            }
          }
        } else {
          logVerbose("before_reset: no session file available, firing hook with empty messages");
        }
        await hookRunner.runBeforeReset(
          { sessionFile, messages, reason: commandAction },
          {
            agentId: params.sessionKey?.split(":")[0] ?? "main",
            sessionKey: params.sessionKey,
            sessionId: prevEntry?.sessionId,
            workspaceDir: params.workspaceDir,
          },
        );
      } catch (err: unknown) {
        logVerbose(`before_reset hook failed: ${String(err)}`);
      }
    })();
  }
}

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
      handleSessionCommand,
      handleRestartCommand,
      handleTtsCommands,
      handleHelpCommand,
      handleCommandsListCommand,
      handleStatusCommand,
      handleAllowlistCommand,
      handleApproveCommand,
      handleContextCommand,
      handleExportSessionCommand,
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
    const commandAction: ResetCommandAction = resetMatch?.[1] === "reset" ? "reset" : "new";
    await emitResetCommandHooks({ ...params, action: commandAction });
    // Mark the command context so that maybeEmitMissingResetHooks (in getReplyFromConfig)
    // knows the hook was already fired and does not double-emit.
    params.command.resetHookTriggered = true;
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
