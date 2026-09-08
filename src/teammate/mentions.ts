/**
 * Named-Bot @mentions: route @Researcher / @axwel-backend to that agent.
 *
 * identity.theme stays a project label (e.g. AXWEL). Mentions use id, name,
 * identity.name, identity.title — never theme slogans.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, sanitizeAgentId } from "../routing/session-key.js";

export type MentionedAgentMatch = {
  agentId: string;
  alias: string;
};

function mentionAliasesForAgent(entry: {
  id: string;
  name?: string;
  identity?: { name?: string; title?: string };
}): string[] {
  const aliases = [
    entry.id,
    sanitizeAgentId(entry.id),
    entry.name,
    entry.identity?.name,
    entry.identity?.title,
  ]
    .map((value) => normalizeLowercaseStringOrEmpty(value ?? ""))
    .filter(Boolean);
  return [...new Set(aliases)];
}

const MENTION_TOKEN = /(?:^|[\s(])@([A-Za-z0-9][\w.-]{0,63})/gu;

/** Extract @tokens from inbound channel text. */
export function extractMentionTokens(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  const tokens: string[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const token = match[1];
    if (token) {
      tokens.push(normalizeLowercaseStringOrEmpty(token));
    }
  }
  return tokens;
}

/**
 * Resolve a unique mentioned agent from message text.
 * Ambiguous or empty mentions return undefined so bindings/default routing stay in charge.
 */
export function resolveMentionedAgentId(
  cfg: OpenClawConfig,
  text: string | undefined,
): MentionedAgentMatch | undefined {
  const tokens = extractMentionTokens(text);
  if (tokens.length === 0) {
    return undefined;
  }
  const aliasToAgent = new Map<string, string>();
  for (const entry of listAgentEntries(cfg)) {
    if (!entry?.id) {
      continue;
    }
    const agentId = normalizeAgentId(entry.id);
    for (const alias of mentionAliasesForAgent(entry)) {
      const existing = aliasToAgent.get(alias);
      if (existing && existing !== agentId) {
        aliasToAgent.delete(alias);
        continue;
      }
      aliasToAgent.set(alias, agentId);
    }
  }
  const matched = new Map<string, string>();
  for (const token of tokens) {
    const agentId = aliasToAgent.get(token);
    if (agentId) {
      matched.set(agentId, token);
    }
  }
  if (matched.size !== 1) {
    return undefined;
  }
  const [agentId, alias] = [...matched.entries()][0]!;
  return { agentId, alias };
}
