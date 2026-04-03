import { normalizeExplicitDiscordSessionKey } from "../../../extensions/discord/api.js";
import type { MsgContext } from "../../auto-reply/templating.js";

type ExplicitSessionKeyNormalizer = (sessionKey: string, ctx: MsgContext) => string;
type ExplicitSessionKeyNormalizerEntry = {
  provider: string;
  normalize: ExplicitSessionKeyNormalizer;
  matches: (params: {
    sessionKey: string;
    provider?: string;
    surface?: string;
    from: string;
  }) => boolean;
};

const EXPLICIT_SESSION_KEY_NORMALIZERS: ExplicitSessionKeyNormalizerEntry[] = [
  {
    provider: "discord",
    normalize: normalizeExplicitDiscordSessionKey,
    matches: ({ sessionKey, provider, surface, from }) =>
      surface === "discord" ||
      provider === "discord" ||
      from.startsWith("discord:") ||
      sessionKey.startsWith("discord:") ||
      sessionKey.includes(":discord:"),
  },
];

function resolveExplicitSessionKeyNormalizer(
  sessionKey: string,
  ctx: Pick<MsgContext, "From" | "Provider" | "Surface">,
): ExplicitSessionKeyNormalizer | undefined {
  const normalizedProvider = ctx.Provider?.trim().toLowerCase();
  const normalizedSurface = ctx.Surface?.trim().toLowerCase();
  const normalizedFrom = (ctx.From ?? "").trim().toLowerCase();
  return EXPLICIT_SESSION_KEY_NORMALIZERS.find((entry) =>
    entry.matches({
      sessionKey,
      provider: normalizedProvider,
      surface: normalizedSurface,
      from: normalizedFrom,
    }),
  )?.normalize;
}

export function normalizeExplicitSessionKey(sessionKey: string, ctx: MsgContext): string {
  const normalized = sessionKey.trim().toLowerCase();
  const normalize = resolveExplicitSessionKeyNormalizer(normalized, ctx);
  return normalize ? normalize(normalized, ctx) : normalized;
}
