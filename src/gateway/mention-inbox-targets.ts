import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MentionSharingTarget } from "./human-mention-policy.js";
import { formatMentionSessionTitle } from "./mention-inbox-presentation.js";
import { mentionTargetKey, type StoredMention } from "./mention-inbox-projection.js";
import { MAX_MENTION_SOURCES } from "./mention-inbox-store.js";
import { prepareSessionSharingRead } from "./session-sharing-target-read.js";
import { resolveSessionSharingTargetAsync } from "./session-sharing.js";

type PreparedTarget = {
  sessionKey: string;
  aliases: Set<string>;
  target: MentionSharingTarget;
  sessionTitle: string;
  facts: Awaited<ReturnType<typeof prepareSessionSharingRead>>;
};

/** One bounded set of retained sharing facts for the Inbox's current view. */
export function createMentionTargetCache(params: {
  getRuntimeConfig: () => OpenClawConfig;
  readItems: () => Iterable<StoredMention>;
}) {
  const connectedTargets = new Map<string, PreparedTarget>();
  const targetAliases = new Map<string, string>();

  function readTarget(key: string): PreparedTarget | null {
    const prepared = connectedTargets.get(targetAliases.get(key) ?? key);
    if (!prepared) {
      return null;
    }
    try {
      const { target: current, membership } = prepared.facts.readCurrent(params.getRuntimeConfig());
      if (!current) {
        return null;
      }
      prepared.target = { ...current, membership };
      return prepared;
    } catch {
      return null;
    }
  }

  async function prepareTarget(
    sessionKey: string,
    agentId?: string,
    key = mentionTargetKey(sessionKey, agentId),
  ): Promise<void> {
    if (readTarget(key)) {
      return;
    }
    removeTarget(targetAliases.get(key) ?? key);
    const cfg = params.getRuntimeConfig();
    const target = await resolveSessionSharingTargetAsync({ cfg, sessionKey, agentId });
    if (!target) {
      return;
    }
    const canonicalKey = mentionTargetKey(target.canonicalKey, target.agentId);
    const existing = readTarget(canonicalKey);
    if (existing) {
      targetAliases.set(key, canonicalKey);
      existing.aliases.add(key);
      return;
    }
    removeTarget(canonicalKey);
    if (connectedTargets.size >= MAX_MENTION_SOURCES) {
      pruneTargets();
    }
    const facts = await prepareSessionSharingRead({ cfg, sessionKey, agentId: target.agentId });
    // Sharing facts omit display fields; row publications invalidate this prepared title.
    const prepared = {
      sessionKey,
      target,
      sessionTitle: formatMentionSessionTitle(target.entry),
      facts,
      aliases: new Set([key]),
    };
    connectedTargets.set(canonicalKey, prepared);
    targetAliases.set(key, canonicalKey);
  }

  async function prepareTargets(): Promise<void> {
    for (const item of params.readItems()) {
      const { sessionKey, agentId } = item.message.content;
      await prepareTarget(sessionKey, agentId, item.targetKey);
    }
  }

  function removeTarget(key: string): void {
    const prepared = connectedTargets.get(key);
    if (!prepared) {
      return;
    }
    prepared.facts.release();
    connectedTargets.delete(key);
    for (const alias of prepared.aliases) {
      targetAliases.delete(alias);
    }
  }

  function pruneTargets(): void {
    const retained = new Set<string>();
    for (const item of params.readItems()) {
      retained.add(targetAliases.get(item.targetKey) ?? item.targetKey);
    }
    // The view owns its complete source set; aliases never consume another source slot.
    for (const key of connectedTargets.keys()) {
      if (!retained.has(key)) {
        removeTarget(key);
      }
    }
  }

  function invalidateTargets(sessionKey?: string): void {
    if (!sessionKey) {
      for (const prepared of connectedTargets.values()) {
        prepared.facts.release();
      }
      connectedTargets.clear();
      targetAliases.clear();
      return;
    }
    for (const [key, cached] of connectedTargets) {
      if (cached.sessionKey === sessionKey || cached.target.storeKeys.includes(sessionKey)) {
        removeTarget(key);
      }
    }
  }

  return { readTarget, prepareTarget, prepareTargets, invalidateTargets };
}
