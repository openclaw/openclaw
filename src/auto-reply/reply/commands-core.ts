import fs from "node:fs/promises";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { isAcpSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
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
    HANDLERS = (await loadCommandHandlersRuntime()).loadCommandHandlers();
  }
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/)
    ?? params.command.commandBodyNormalized.match(/^(new|reset)$/i);
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
