import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeExplicitDiscordSessionKey } from "../../discord/session-key-normalization.js";

type ExplicitSessionKeyNormalizer = (sessionKey: string, ctx: MsgContext) => string;

const EXPLICIT_SESSION_KEY_NORMALIZERS: Record<string, ExplicitSessionKeyNormalizer> = {
  discord: normalizeExplicitDiscordSessionKey,
};

function resolveExplicitSessionKeyProvider(
  sessionKey: string,
  ctx: Pick<MsgContext, "From" | "Provider" | "Surface">,
): string | undefined {
  const explicitProvider = [ctx.Surface, ctx.Provider]
    .map((entry) => entry?.trim().toLowerCase())
    .find((entry) => entry && entry in EXPLICIT_SESSION_KEY_NORMALIZERS);
  if (explicitProvider) {
    return explicitProvider;
  }

  const from = (ctx.From ?? "").trim().toLowerCase();
  if (from.startsWith("discord:")) {
    return "discord";
  }
  if (sessionKey.startsWith("discord:") || sessionKey.includes(":discord:")) {
    return "discord";
  }
  return undefined;
}

export function normalizeExplicitSessionKey(sessionKey: string, ctx: MsgContext): string {
  const normalized = sessionKey.trim().toLowerCase();
  const provider = resolveExplicitSessionKeyProvider(normalized, ctx);
  return provider ? EXPLICIT_SESSION_KEY_NORMALIZERS[provider](normalized, ctx) : normalized;
}
