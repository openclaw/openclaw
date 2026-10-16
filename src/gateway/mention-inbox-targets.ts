import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { StoredMention } from "./mention-inbox-projection.js";
import { MAX_MENTION_SOURCES } from "./mention-inbox-store.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import { prepareSessionSharingRead } from "./session-sharing-target-read.js";
import { resolveSessionSharingTargetAsync } from "./session-sharing.js";

type SharingTargets = Map<
  string,
  {
    sessionKey: string;
    aliases: Set<string>;
    target: SessionSharingTarget;
    facts: Awaited<ReturnType<typeof prepareSessionSharingRead>>;
  }
>;

/** One bounded set of retained sharing facts for the Inbox's current view. */
export function createMentionTargetCache(params: {
  getRuntimeConfig: () => OpenClawConfig;
  readItems: () => Iterable<StoredMention>;
}) {
  const connectedTargets: SharingTargets = new Map();
  const targetAliases = new Map<string, string>();

  function readTarget(sessionKey: string, agentId?: string): SessionSharingTarget | null {
    const key = JSON.stringify([agentId, sessionKey]);
    const prepared = connectedTargets.get(targetAliases.get(key) ?? key);
    if (!prepared) {
      return null;
    }
    try {
      const current = prepared.facts.readCurrent(params.getRuntimeConfig()).target;
      return current
        ? { ...prepared.target, ...current, entry: { ...prepared.target.entry, ...current.entry } }
        : null;
    } catch {
      return null;
    }
  }

  async function prepareTarget(sessionKey: string, agentId?: string): Promise<void> {
    const key = JSON.stringify([agentId, sessionKey]);
    if (readTarget(sessionKey, agentId)) {
      return;
    }
    removeTarget(targetAliases.get(key) ?? key);
    const cfg = params.getRuntimeConfig();
    const target = await resolveSessionSharingTargetAsync({ cfg, sessionKey, agentId });
    if (!target) {
      return;
    }
    const canonicalKey = JSON.stringify([target.agentId, target.canonicalKey]);
    if (readTarget(target.canonicalKey, target.agentId)) {
      targetAliases.set(key, canonicalKey);
      connectedTargets.get(canonicalKey)!.aliases.add(key);
      return;
    }
    removeTarget(canonicalKey);
    if (connectedTargets.size >= MAX_MENTION_SOURCES) {
      pruneTargets(key);
    }
    const facts = await prepareSessionSharingRead({ cfg, sessionKey, agentId: target.agentId });
    const prepared = { sessionKey, target, facts, aliases: new Set([key]) };
    connectedTargets.set(canonicalKey, prepared);
    targetAliases.set(key, canonicalKey);
  }

  async function prepareTargets(): Promise<void> {
    for (const item of params.readItems()) {
      const { sessionKey, agentId } = item.message.content;
      await prepareTarget(sessionKey, agentId);
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

  function pruneTargets(additionalKey?: string): void {
    const retained = new Set<string>();
    for (const item of params.readItems()) {
      const { agentId, sessionKey } = item.message.content;
      const key = JSON.stringify([agentId, sessionKey]);
      retained.add(targetAliases.get(key) ?? key);
    }
    if (additionalKey) {
      retained.add(targetAliases.get(additionalKey) ?? additionalKey);
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
      if (cached.sessionKey === sessionKey || cached.target?.storeKeys.includes(sessionKey)) {
        removeTarget(key);
      }
    }
  }

  return { readTarget, prepareTarget, prepareTargets, invalidateTargets };
}
