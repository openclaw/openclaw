import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { buildChannelSummary } from "../infra/channel-summary.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { resolveHeartbeatSeconds } from "../web/reconnect.js";
import { resolveLinkChannelContext } from "./status.link-channel.js";
import type { SessionStatus, StatusSummary } from "./status.types.js";

const classifyKey = (
  key: string,
  entry?: SessionEntry,
): SessionStatus["kind"] => {
  if (key === "global") return "global";
  if (key === "unknown") return "unknown";
  if (entry?.chatType === "group" || entry?.chatType === "room") return "group";
  if (
    key.startsWith("group:") ||
    key.includes(":group:") ||
    key.includes(":channel:")
  ) {
    return "group";
  }
  return "direct";
};

const buildFlags = (entry: SessionEntry): string[] => {
  const flags: string[] = [];
  const think = entry?.thinkingLevel;
  if (typeof think === "string" && think.length > 0)
    flags.push(`think:${think}`);
  const verbose = entry?.verboseLevel;
  if (typeof verbose === "string" && verbose.length > 0)
    flags.push(`verbose:${verbose}`);
  const reasoning = entry?.reasoningLevel;
  if (typeof reasoning === "string" && reasoning.length > 0)
    flags.push(`reasoning:${reasoning}`);
  const elevated = entry?.elevatedLevel;
  if (typeof elevated === "string" && elevated.length > 0)
    flags.push(`elevated:${elevated}`);
  if (entry?.systemSent) flags.push("system");
  if (entry?.abortedLastRun) flags.push("aborted");
  const sessionId = entry?.sessionId as unknown;
  if (typeof sessionId === "string" && sessionId.length > 0)
    flags.push(`id:${sessionId}`);
  return flags;
};

export async function getStatusSummary(): Promise<StatusSummary> {
  const cfg = loadConfig();
  const linkContext = await resolveLinkChannelContext(cfg);
  const heartbeatSeconds = resolveHeartbeatSeconds(cfg, undefined);
  const channelSummary = await buildChannelSummary(cfg, {
    colorize: true,
    includeAllowFrom: true,
  });
  const mainSessionKey = resolveMainSessionKey(cfg);
  const queuedSystemEvents = peekSystemEvents(mainSessionKey);

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const configContextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(configModel) ??
    DEFAULT_CONTEXT_TOKENS;

  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const now = Date.now();
  const sessions = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      const age = updatedAt ? now - updatedAt : null;
      const model = entry?.model ?? configModel ?? null;
      const contextTokens =
        entry?.contextTokens ??
        lookupContextTokens(model) ??
        configContextTokens ??
        null;
      const input = entry?.inputTokens ?? 0;
      const output = entry?.outputTokens ?? 0;
      const total = entry?.totalTokens ?? input + output;
      const remaining =
        contextTokens != null ? Math.max(0, contextTokens - total) : null;
      const pct =
        contextTokens && contextTokens > 0
          ? Math.min(999, Math.round((total / contextTokens) * 100))
          : null;

      return {
        key,
        kind: classifyKey(key, entry),
        sessionId: entry?.sessionId,
        updatedAt,
        age,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        elevatedLevel: entry?.elevatedLevel,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: total ?? null,
        remainingTokens: remaining,
        percentUsed: pct,
        model,
        contextTokens,
        flags: buildFlags(entry),
      } satisfies SessionStatus;
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const recent = sessions.slice(0, 5);

  return {
    linkChannel: linkContext
      ? {
          id: linkContext.plugin.id,
          label: linkContext.plugin.meta.label ?? "Channel",
          linked: linkContext.linked,
          authAgeMs: linkContext.authAgeMs,
        }
      : undefined,
    heartbeatSeconds,
    channelSummary,
    queuedSystemEvents,
    sessions: {
      path: storePath,
      count: sessions.length,
      defaults: {
        model: configModel ?? null,
        contextTokens: configContextTokens ?? null,
      },
      recent,
    },
  };
}
