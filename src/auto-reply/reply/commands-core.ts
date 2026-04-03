import fs from "node:fs/promises";
import { resetAcpSessionInPlace } from "../../acp/persistent-bindings.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../../config/sessions.js";
import path from "node:path";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { isAcpSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleApproveCommand } from "./commands-approve.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleBtwCommand } from "./commands-btw.js";
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
import { handleLearnCommand, runLearnForSession } from "./commands-learn.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { handleModelsCommand } from "./commands-models.js";
import { handlePluginCommand } from "./commands-plugin.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleFastCommand,
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

let routeReplyRuntimePromise: Promise<typeof import("./route-reply.runtime.js")> | null = null;
let commandHandlersRuntimePromise: Promise<typeof import("./commands-handlers.runtime.js")> | null =
  null;

function loadRouteReplyRuntime() {
  routeReplyRuntimePromise ??= import("./route-reply.runtime.js");
  return routeReplyRuntimePromise;
}

function loadCommandHandlersRuntime() {
  commandHandlersRuntimePromise ??= import("./commands-handlers.runtime.js");
  return commandHandlersRuntimePromise;
}

let HANDLERS: CommandHandler[] | null = null;

export type ResetCommandAction = "new" | "reset";

// Reset hooks only need the transcript message payloads, not session headers or metadata rows.
function parseTranscriptMessages(content: string): unknown[] {
  const messages: unknown[] = [];
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
      // Skip malformed lines from partially-written transcripts.
    }
  }
  return messages;
}

// Once /reset rotates a transcript, the newest archived sibling is the best fallback source.
async function findLatestArchivedTranscript(sessionFile: string): Promise<string | undefined> {
  try {
    const dir = path.dirname(sessionFile);
    const base = path.basename(sessionFile);
    const resetPrefix = `${base}.reset.`;
    const archived = (await fs.readdir(dir))
      .filter((name) => name.startsWith(resetPrefix))
      .toSorted();
    const latest = archived[archived.length - 1];
    return latest ? path.join(dir, latest) : undefined;
  } catch {
    return undefined;
  }
}

// Prefer the live transcript path, but fall back to the archived reset transcript when rotation won the race.
async function loadBeforeResetTranscript(params: {
  sessionFile?: string;
}): Promise<{ sessionFile?: string; messages: unknown[] }> {
  const sessionFile = params.sessionFile;
  if (!sessionFile) {
    logVerbose("before_reset: no session file available, firing hook with empty messages");
    return { sessionFile, messages: [] };
  }

  try {
    return {
      sessionFile,
      messages: parseTranscriptMessages(await fs.readFile(sessionFile, "utf-8")),
    };
  } catch (err: unknown) {
    if ((err as { code?: unknown })?.code !== "ENOENT") {
      logVerbose(
        `before_reset: failed to read session file ${sessionFile}; firing hook with empty messages (${String(err)})`,
      );
      return { sessionFile, messages: [] };
    }
  }

  const archivedSessionFile = await findLatestArchivedTranscript(sessionFile);
  if (!archivedSessionFile) {
    logVerbose(
      `before_reset: failed to find archived transcript for ${sessionFile}; firing hook with empty messages`,
    );
    return { sessionFile, messages: [] };
  }

  try {
    return {
      sessionFile: archivedSessionFile,
      messages: parseTranscriptMessages(await fs.readFile(archivedSessionFile, "utf-8")),
    };
  } catch (err: unknown) {
    logVerbose(
      `before_reset: failed to read archived session file ${archivedSessionFile}; firing hook with empty messages (${String(err)})`,
    );
    return { sessionFile: archivedSessionFile, messages: [] };
  }
}

export async function emitResetCommandHooks(params: {
  action: ResetCommandAction;
  ctx: HandleCommandsParams["ctx"];
  cfg: HandleCommandsParams["cfg"];
  command: Pick<
    HandleCommandsParams["command"],
    "surface" | "senderId" | "channel" | "from" | "to" | "resetHookTriggered"
  >;
  sessionKey?: string;
  sessionEntry?: HandleCommandsParams["sessionEntry"];
  previousSessionEntry?: HandleCommandsParams["previousSessionEntry"];
  workspaceDir: string;
}): Promise<void> {
  const hookEvent = createInternalHookEvent("command", params.action, params.sessionKey ?? "", {
    sessionEntry: params.sessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    commandSource: params.command.surface,
    senderId: params.command.senderId,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg, // Pass config for LLM slug generation
  });
  await triggerInternalHook(hookEvent);
  params.command.resetHookTriggered = true;

  // Send hook messages immediately if present
  if (hookEvent.messages.length > 0) {
    // Use OriginatingChannel/To if available, otherwise fall back to command channel/from
    // oxlint-disable-next-line typescript/no-explicit-any
    const channel = params.ctx.OriginatingChannel || (params.command.channel as any);
    // For replies, use 'from' (the sender) not 'to' (which might be the bot itself)
    const to = params.ctx.OriginatingTo || params.command.from || params.command.to;

    if (channel && to) {
      const { routeReply } = await loadRouteReplyRuntime();
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
    // Fire-and-forget: read old session messages and run hook
    void (async () => {
      const { sessionFile, messages } = await loadBeforeResetTranscript({
        sessionFile: prevEntry?.sessionFile,
      });

      try {
        await hookRunner.runBeforeReset(
          { sessionFile, messages, reason: params.action },
          {
            agentId: resolveAgentIdFromSessionKey(params.sessionKey),
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

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  const mutableCtx = ctx as Record<string, unknown>;
  mutableCtx.Body = resetTail;
  mutableCtx.RawBody = resetTail;
  mutableCtx.CommandBody = resetTail;
  mutableCtx.BodyForCommands = resetTail;
  mutableCtx.BodyForAgent = resetTail;
  mutableCtx.BodyStripped = resetTail;
  mutableCtx.AcpDispatchTailAfterReset = true;
}

function resolveSessionEntryForHookSessionKey(
  sessionStore: HandleCommandsParams["sessionStore"] | undefined,
  sessionKey: string,
): HandleCommandsParams["sessionEntry"] | undefined {
  if (!sessionStore) {
    return undefined;
  }
  const directEntry = sessionStore[sessionKey];
  if (directEntry) {
    return directEntry;
  }
  const normalizedTarget = sessionKey.trim().toLowerCase();
  if (!normalizedTarget) {
    return undefined;
  }
  for (const [candidateKey, candidateEntry] of Object.entries(sessionStore)) {
    if (candidateKey.trim().toLowerCase() === normalizedTarget) {
      return candidateEntry;
    }
  }
  return undefined;
}

export async function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult> {
  if (HANDLERS === null) {
    HANDLERS = [
      // Plugin commands are processed first, before built-in commands
      handlePluginCommand,
      handleBtwCommand,
      handleBashCommand,
      handleActivationCommand,
      handleSendPolicyCommand,
      handleFastCommand,
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
      handleAcpCommand,
      handleMcpCommand,
      handlePluginsCommand,
      handleConfigCommand,
      handleDebugCommand,
      handleModelsCommand,
      handleStopCommand,
      handleCompactCommand,
      handleLearnCommand,
      handleAbortTrigger,
    ];
    HANDLERS = (await loadCommandHandlersRuntime()).loadCommandHandlers();
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
    const resetTail =
      resetMatch != null
        ? params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart()
        : "";
    const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
    const boundAcpKey =
      boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
        ? boundAcpSessionKey.trim()
        : undefined;

    // Determine which session to learn from (after ACP resolution)
    // For non-ACP resets, use previousSessionEntry because initSessionState already rotated to fresh session
    const targetSessionKey = boundAcpKey ?? params.sessionKey;
    let targetSessionEntry: typeof params.sessionEntry;
    if (boundAcpKey) {
      targetSessionEntry = resolveSessionEntryForHookSessionKey(params.sessionStore, boundAcpKey);
    } else if (params.previousSessionEntry?.sessionId) {
      targetSessionEntry = params.previousSessionEntry;
    } else {
      targetSessionEntry = params.sessionEntry;
    }

    // Trigger learning before reset/new commands (after ACP target resolution)
    // Run in background with dedicated lane to avoid blocking user interactions
    if (targetSessionEntry?.sessionId && targetSessionEntry.sessionFile) {
      const thinkLevel = params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel());
      runLearnForSession({
        sessionId: targetSessionEntry.sessionId,
        sessionKey: targetSessionKey,
        messageChannel: params.command.channel,
        groupId: targetSessionEntry.groupId,
        groupChannel: targetSessionEntry.groupChannel,
        groupSpace: targetSessionEntry.space,
        spawnedBy: targetSessionEntry.spawnedBy,
        sessionFile: targetSessionEntry.sessionFile,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.cfg,
        skillsSnapshot: targetSessionEntry.skillsSnapshot,
        provider: params.provider,
        model: params.model,
        thinkLevel,
        customFocus:
          "What insights and lessons should be remembered before starting a new session?",
        senderIsOwner: params.command.senderIsOwner,
        ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
        lane: "learn",
      }).then((learnResult) => {
        if (learnResult.ok) {
          logVerbose(`Background pre-reset learning completed for session ${targetSessionKey}`);
        } else {
          logVerbose(
            `Background pre-reset learning failed for session ${targetSessionKey}: ${learnResult.message ?? "unknown error"}`,
          );
        }
      });
    }
    if (boundAcpKey) {
      const resetResult = await resetConfiguredBindingTargetInPlace({
        cfg: params.cfg,
        sessionKey: boundAcpKey,
        reason: commandAction,
      });
      if (!resetResult.ok && !resetResult.skipped) {
        logVerbose(
          `acp reset-in-place failed for ${boundAcpKey}: ${resetResult.error ?? "unknown error"}`,
        );
      }
      if (resetResult.ok) {
        const hookSessionEntry =
          boundAcpKey === params.sessionKey
            ? params.sessionEntry
            : resolveSessionEntryForHookSessionKey(params.sessionStore, boundAcpKey);
        const hookPreviousSessionEntry =
          boundAcpKey === params.sessionKey
            ? params.previousSessionEntry
            : resolveSessionEntryForHookSessionKey(params.sessionStore, boundAcpKey);
        await emitResetCommandHooks({
          action: commandAction,
          ctx: params.ctx,
          cfg: params.cfg,
          command: params.command,
          sessionKey: boundAcpKey,
          sessionEntry: hookSessionEntry,
          previousSessionEntry: hookPreviousSessionEntry,
          workspaceDir: params.workspaceDir,
        });
        if (resetTail) {
          applyAcpResetTailContext(params.ctx, resetTail);
          if (params.rootCtx && params.rootCtx !== params.ctx) {
            applyAcpResetTailContext(params.rootCtx, resetTail);
          }
          return {
            shouldContinue: false,
          };
        }
        return {
          shouldContinue: false,
          reply: { text: "✅ ACP session reset in place." },
        };
      }
      if (resetResult.skipped) {
        return {
          shouldContinue: false,
          reply: {
            text: "⚠️ ACP session reset unavailable for this bound conversation. Rebind with /acp bind or /acp spawn.",
          },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ ACP session reset failed. Check /acp status and try again.",
        },
      };
    }
    await emitResetCommandHooks({
      action: commandAction,
      ctx: params.ctx,
      cfg: params.cfg,
      command: params.command,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      previousSessionEntry: params.previousSessionEntry,
      workspaceDir: params.workspaceDir,
    });
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
