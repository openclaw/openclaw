/** Handles /new and /reset command flows, including soft reset and ACP-bound sessions. */
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { writeSessionLabel } from "./commands-name.js";
import { emitResetCommandHooks, type ResetCommandAction } from "./commands-reset-hooks.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
import type { ReplySessionBinding } from "./get-reply.types.js";
import { isResetAuthorizedForContext } from "./reset-authorization.js";

type InternalResetCommandOptions = NonNullable<HandleCommandsParams["opts"]> & {
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
};

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  const mutableCtx = ctx as Record<string, unknown>;
  mutableCtx.Body = resetTail;
  mutableCtx.RawBody = resetTail;
  mutableCtx.CommandBody = resetTail;
  mutableCtx.BodyForCommands = resetTail;
  mutableCtx.BodyForAgent = resetTail;
  mutableCtx.BodyStripped = resetTail;
  // Mark the context so ACP dispatch continues with the post-reset tail, not the reset command.
  mutableCtx.AcpDispatchTailAfterReset = true;
}

function collectConfiguredModelRefs(params: HandleCommandsParams): Set<string> {
  const refs = new Set<string>();
  const providers = (
    params.cfg as {
      models?: {
        providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
      };
    }
  ).models?.providers;
  if (!providers) {
    return refs;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    refs.add(providerId.toLowerCase());
    for (const model of provider.models ?? []) {
      const modelId = typeof model.id === "string" ? model.id.trim() : "";
      const modelName = typeof model.name === "string" ? model.name.trim() : "";
      for (const value of [modelId, modelName]) {
        if (!value) {
          continue;
        }
        refs.add(value.toLowerCase());
        refs.add(`${providerId}/${value}`.toLowerCase());
      }
    }
  }
  return refs;
}

const MODEL_REF_PREFIX_RE =
  /^(?:gpt|o[134]|claude|gemini|llama|mistral|mixtral|codestral|qwen|deepseek|grok|kimi|command-r|sonar|phi)(?:[-_:./]|\d|$)/i;

function isModelRefTail(params: HandleCommandsParams, tail: string): boolean {
  const normalized = tail.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const refs = collectConfiguredModelRefs(params);
  const tokens = normalized.split(/\s+/);
  if (tokens.length === 2) {
    const [provider, model] = tokens;
    if (provider && model && refs.has(provider)) {
      return refs.has(`${provider}/${model}`) || refs.has(model) || MODEL_REF_PREFIX_RE.test(model);
    }
  }
  if (
    !normalized.includes("/") &&
    buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: params.provider || DEFAULT_PROVIDER,
    }).byAlias.has(normalized)
  ) {
    return true;
  }
  if (refs.has(normalized)) {
    return true;
  }
  if (normalized.includes("/")) {
    return true;
  }
  return MODEL_REF_PREFIX_RE.test(normalized);
}

function getNativeCommandTitleTail(params: HandleCommandsParams): string | undefined {
  if ((params.ctx.CommandSource ?? "text") === "text") {
    return undefined;
  }
  const title = params.ctx.CommandArgs?.values?.title;
  if (typeof title !== "string" || !title.trim()) {
    return undefined;
  }
  const trimmed = title.trim();
  const newMatch = trimmed.match(/^\/new(?:\s+(.+))?$/i);
  return newMatch ? newMatch[1]?.trim() : trimmed;
}

function parseExplicitNamedNewSessionTail(tail: string): string | undefined {
  if (/^(?:--model(?:=|\s+)|model:)/i.test(tail)) {
    return undefined;
  }
  const flagMatch = tail.match(/^--name(?:=|\s+)(.+)$/i);
  if (flagMatch?.[1]) {
    return flagMatch[1].trim();
  }
  const prefixMatch = tail.match(/^name:(.+)$/i);
  if (prefixMatch?.[1]) {
    return prefixMatch[1].trim();
  }
  const quotedMatch = tail.match(/^"([^"]+)"$|^'([^']+)'$/);
  if (quotedMatch?.[1] || quotedMatch?.[2]) {
    return (quotedMatch[1] ?? quotedMatch[2] ?? "").trim();
  }
  return undefined;
}

function parseNamedNewSessionTail(
  params: HandleCommandsParams,
  resetTail: string,
): string | undefined {
  const nativeTitle = getNativeCommandTitleTail(params);
  if (nativeTitle) {
    const explicitNativeName = parseExplicitNamedNewSessionTail(nativeTitle);
    if (explicitNativeName) {
      return explicitNativeName;
    }
    return isModelRefTail(params, nativeTitle) ? undefined : nativeTitle;
  }
  const tail = resetTail.trim();
  if (!tail) {
    return undefined;
  }
  const explicitName = parseExplicitNamedNewSessionTail(tail);
  if (explicitName) {
    return explicitName;
  }
  if (/^(?:--model(?:=|\s+)|model:)/i.test(tail)) {
    return undefined;
  }
  if (!tail.startsWith("-") && !/\s/.test(tail) && !isModelRefTail(params, tail)) {
    return tail;
  }
  return undefined;
}

function isResetAuthorized(params: HandleCommandsParams): boolean {
  return isResetAuthorizedForContext({
    ctx: params.ctx,
    cfg: params.cfg,
    commandAuthorized: params.command.isAuthorizedSender || params.ctx.CommandAuthorized === true,
  });
}

/** Handles reset/new commands or returns null when another command handler should continue. */
export async function maybeHandleResetCommand(
  params: HandleCommandsParams,
): Promise<CommandHandlerResult | null> {
  const softReset = parseSoftResetCommand(params.command.commandBodyNormalized);
  if (softReset.matched) {
    if (!isResetAuthorized(params)) {
      logVerbose(
        `Ignoring /reset soft from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }

    const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
    const boundAcpKey =
      boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
        ? boundAcpSessionKey.trim()
        : undefined;
    if (boundAcpKey) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /reset soft is not available for ACP-bound sessions yet." },
      };
    }

    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const previousSessionEntry =
      params.previousSessionEntry ?? (targetSessionEntry ? { ...targetSessionEntry } : undefined);
    if (targetSessionEntry) {
      const now = Date.now();
      clearAllCliSessions(targetSessionEntry);
      if (params.sessionEntry && params.sessionEntry !== targetSessionEntry) {
        clearAllCliSessions(params.sessionEntry);
        params.sessionEntry.updatedAt = now;
        params.sessionEntry.lastInteractionAt = now;
      }
      if (params.sessionKey) {
        clearBootstrapSnapshot(params.sessionKey);
      }
      targetSessionEntry.updatedAt = now;
      targetSessionEntry.lastInteractionAt = now;
      if (params.sessionStore && params.sessionKey) {
        params.sessionStore[params.sessionKey] = targetSessionEntry;
      }
      if (params.storePath && params.sessionKey) {
        await updateSessionEntry(
          {
            storePath: params.storePath,
            sessionKey: params.sessionKey,
          },
          async (entry) => {
            const next = { ...entry };
            clearAllCliSessions(next);
            return {
              cliSessionBindings: next.cliSessionBindings,
              cliSessionIds: next.cliSessionIds,
              claudeCliSessionId: next.claudeCliSessionId,
              updatedAt: now,
              lastInteractionAt: now,
            };
          },
        );
      }
    }

    await emitResetCommandHooks({
      action: "reset",
      ctx: params.ctx,
      cfg: params.cfg,
      command: params.command,
      sessionKey: params.sessionKey,
      sessionEntry: targetSessionEntry,
      previousSessionEntry,
      workspaceDir: params.workspaceDir,
    });
    params.command.softResetTriggered = true;
    params.command.softResetTail = softReset.tail;
    return null;
  }

  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/i);
  if (!resetMatch) {
    return null;
  }
  if (!isResetAuthorized(params)) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const commandAction: ResetCommandAction =
    resetMatch[1]?.toLowerCase() === "reset" ? "reset" : "new";
  const resetTail = params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart();
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
      commandSource: `${params.command.surface}:${params.ctx.CommandSource ?? "text"}`,
    });
    if (!resetResult.ok) {
      logVerbose(`acp reset failed for ${boundAcpKey}: ${resetResult.error ?? "unknown error"}`);
    }
    if (resetResult.ok) {
      if (resetResult.sessionId) {
        (params.opts as InternalResetCommandOptions | undefined)?.onSessionPrepared?.({
          sessionKey: resetResult.sessionKey ?? boundAcpKey,
          sessionId: resetResult.sessionId,
          storePath: resetResult.storePath,
        });
      }
      params.command.resetHookTriggered = true;
      if (resetTail) {
        applyAcpResetTailContext(params.ctx, resetTail);
        if (params.rootCtx && params.rootCtx !== params.ctx) {
          applyAcpResetTailContext(params.rootCtx, resetTail);
        }
        return { shouldContinue: false };
      }
      return {
        shouldContinue: false,
        reply: { text: "✅ ACP session reset in place." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "⚠️ ACP session reset failed. Check /acp status and try again." },
    };
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  const hookResult = await emitResetCommandHooks({
    action: commandAction,
    ctx: params.ctx,
    cfg: params.cfg,
    command: params.command,
    sessionKey: params.sessionKey,
    sessionEntry: targetSessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    workspaceDir: params.workspaceDir,
  });
  const newSessionTitle =
    commandAction === "new" ? parseNamedNewSessionTail(params, resetTail) : undefined;
  if (newSessionTitle) {
    const writeResult = await writeSessionLabel(params, newSessionTitle);
    if (!writeResult.ok) {
      return {
        shouldContinue: false,
        reply: { text: `✅ New session started, but couldn't name it: ${writeResult.error}` },
      };
    }
    markCommandSessionMetadataChanged(params);
    return {
      shouldContinue: false,
      ...(hookResult.routedReply
        ? {}
        : { reply: { text: `✅ New session started as “${writeResult.label}”.` } }),
    };
  }
  if (!resetTail) {
    return {
      shouldContinue: false,
      ...(hookResult.routedReply
        ? {}
        : {
            reply: {
              text: commandAction === "reset" ? "✅ Session reset." : "✅ New session started.",
            },
          }),
    };
  }
  return null;
}
