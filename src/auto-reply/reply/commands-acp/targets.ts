import { resolveEffectiveResetTargetSessionKey } from "../acp-reset-target.js";
import { resolveRequesterSessionKey } from "../commands-subagents/shared.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { resolveSessionKeyByReference } from "../session-target-resolution.js";
import { resolveAcpCommandBindingContext } from "./context.js";

export function resolveBoundAcpThreadSessionKey(params: HandleCommandsParams): string | undefined {
  const commandTargetSessionKey =
    typeof params.ctx.CommandTargetSessionKey === "string"
      ? params.ctx.CommandTargetSessionKey.trim()
      : "";
  const activeSessionKey = commandTargetSessionKey || params.sessionKey.trim();
  const bindingContext = resolveAcpCommandBindingContext(params);
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
    activeSessionKey,
    allowNonAcpBindingSessionKey: true,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
  });
}

export async function resolveAcpTargetSessionKey(params: {
  commandParams: HandleCommandsParams;
  token?: string;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; error: string }> {
  const token = params.token?.trim() || "";
  if (token) {
    const resolved = await resolveSessionKeyByReference({
      cfg: params.commandParams.cfg,
      token,
    });
    if (!resolved) {
      return {
        ok: false,
        error: `Unable to resolve session target: ${token}`,
      };
    }
    return { ok: true, sessionKey: resolved };
  }

  const threadBound = resolveBoundAcpThreadSessionKey(params.commandParams);
  if (threadBound) {
    return {
      ok: true,
      sessionKey: threadBound,
    };
  }

  const fallback = resolveRequesterSessionKey(params.commandParams, {
    preferCommandTarget: true,
  });
  if (!fallback) {
    return {
      ok: false,
      error: "Missing session key.",
    };
  }
  return {
    ok: true,
    sessionKey: fallback,
  };
}
