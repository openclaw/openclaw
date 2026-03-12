import { listAcpSessionEntries } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { SESSION_ID_RE } from "../../sessions/session-id.js";

function resolveAcpSessionKeySuffixToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  if (SESSION_ID_RE.test(trimmed)) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("acp:")) {
    return null;
  }
  const suffix = trimmed.slice("acp:".length).trim();
  return SESSION_ID_RE.test(suffix) ? suffix : null;
}

async function resolveSessionKeyViaGateway(token: string): Promise<string | null> {
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
      // Try the next resolution strategy.
    }
  }
  return null;
}

async function resolveAcpSessionKeyViaFallback(params: {
  cfg: OpenClawConfig;
  token: string;
}): Promise<string | null> {
  const trimmed = params.token.trim();
  const suffix = resolveAcpSessionKeySuffixToken(trimmed);
  if (!suffix) {
    return null;
  }

  let sessions: Awaited<ReturnType<typeof listAcpSessionEntries>>;
  try {
    sessions = await listAcpSessionEntries({ cfg: params.cfg });
  } catch {
    return null;
  }

  const matches = sessions
    .map((session) => session.sessionKey.trim())
    .filter((sessionKey) => sessionKey.endsWith(`:acp:${suffix}`));
  if (matches.length !== 1) {
    return null;
  }
  return matches[0] ?? null;
}

export async function resolveSessionKeyByReference(params: {
  cfg: OpenClawConfig;
  token: string;
}): Promise<string | null> {
  const trimmed = params.token.trim();
  if (!trimmed) {
    return null;
  }

  const resolved = await resolveSessionKeyViaGateway(trimmed);
  if (resolved) {
    return resolved;
  }

  return await resolveAcpSessionKeyViaFallback({
    cfg: params.cfg,
    token: trimmed,
  });
}
