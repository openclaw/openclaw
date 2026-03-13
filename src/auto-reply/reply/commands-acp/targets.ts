import type { HandleCommandsParams } from "../commands-types.js";
import { callGateway } from "../../../gateway/call.js";
import { resolveEffectiveResetTargetSessionKey } from "../acp-reset-target.js";
import { resolveRequesterSessionKey } from "../commands-subagents/shared.js";
import { resolveAcpCommandBindingContext } from "./context.js";
import { SESSION_ID_RE } from "./shared.js";

async function resolveSessionKeyByToken(token: string): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  const attempts: Array<Record<string, string>> = [{ key: trimmed }];
  if (SESSION_ID_RE.test(trimmed)) {
    attempts.push({ sessionId: trimmed });
  }
  attempts.push({ label: trimmed });

  for (const params of attempts) {
    try {
      const resolved = await callGateway<{ key?: string }>({
        method: "sessions.resolve",
        params,
        timeoutMs: 8_000,
      });
      const key = typeof resolved?.key === "string" ? resolved.key.trim() : "";
      if (key) {
        return key;
      }
    } catch {
      // Try next resolver strategy.
    }
  }
  return null;
}

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
    const resolved = await resolveSessionKeyByToken(token);
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
