import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createHumanMentionPolicy } from "./human-mention-policy.js";
import type { InboxState, StoredMention } from "./mention-inbox-projection.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import { prepareSessionSharingRead } from "./session-sharing-target-read.js";
import { resolveSessionSharingTargetAsync } from "./session-sharing.js";

export type SharingTargets = Map<
  string,
  {
    sessionKey: string;
    storeKeys: readonly string[];
    readTarget: () => SessionSharingTarget | null;
    release: () => void;
  }
>;

export function createMentionSharingTargets(params: {
  getRuntimeConfig: () => OpenClawConfig;
  getProjection: () => InboxState;
  now: () => number;
  policy: ReturnType<typeof createHumanMentionPolicy>;
}) {
  const { getRuntimeConfig, getProjection, policy } = params;
  const targets: SharingTargets = new Map();
  let targetConfig: OpenClawConfig | undefined;

  function invalidate(sessionKey?: string): void {
    for (const [key, cached] of targets) {
      if (
        !sessionKey ||
        cached.sessionKey === sessionKey ||
        cached.storeKeys.includes(sessionKey)
      ) {
        cached.release();
        targets.delete(key);
      }
    }
  }

  function currentTarget(
    item: StoredMention,
    cfg: OpenClawConfig,
    preparedTargets: SharingTargets,
    projection = getProjection(),
  ) {
    const { source, message } = item;
    const { agentId, sessionKey, senderProfileId } = message.content;
    if (projection.items.get(item.id) !== item || source.expiresAt <= params.now()) {
      return undefined;
    }
    const key = JSON.stringify([agentId, sessionKey]);
    const resolved = preparedTargets.get(key)?.readTarget();
    if (!resolved || resolved.entry.sessionId !== message.sessionId) {
      return undefined;
    }
    const target = {
      agentId: resolved.agentId,
      sessionKey: resolved.canonicalKey,
      entry: resolved.entry,
    };
    const recipient = policy.recipientProfile(item.recipientProfileId, target, cfg);
    const sender = policy.readProfile(senderProfileId);
    return recipient && recipient.profileId !== sender?.profileId
      ? { target, recipient, sender }
      : undefined;
  }

  return {
    currentTarget,
    targets,
    invalidate,
    async prepare(): Promise<void> {
      const cfg = getRuntimeConfig();
      if (targetConfig !== cfg) {
        invalidate();
        targetConfig = cfg;
      }
      const requested = new Set<string>();
      for (const item of getProjection().items.values()) {
        const { agentId, sessionKey } = item.message.content;
        const key = JSON.stringify([agentId, sessionKey]);
        if (requested.has(key)) {
          continue;
        }
        requested.add(key);
        if (targets.has(key)) {
          continue;
        }
        // Acquire display first: replacement during that await can revoke a sharing receipt.
        const display = await resolveSessionSharingTargetAsync({ cfg, agentId, sessionKey });
        const prepared = await prepareSessionSharingRead({ cfg, agentId, sessionKey });
        targets.set(key, {
          sessionKey,
          storeKeys: display?.storeKeys ?? [sessionKey],
          readTarget: () => {
            const current = prepared.readCurrent(getRuntimeConfig()).target;
            return current && display?.entry.sessionId === current.entry.sessionId
              ? {
                  ...current,
                  entry: {
                    ...current.entry,
                    label: display.entry.label,
                    displayName: display.entry.displayName,
                    subject: display.entry.subject,
                  },
                }
              : current;
          },
          release: prepared.release,
        });
      }
      for (const [key, cached] of targets) {
        if (!requested.has(key)) {
          cached.release();
          targets.delete(key);
        }
      }
    },
  };
}
