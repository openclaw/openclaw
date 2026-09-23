import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { readUserProfileAliases } from "../../state/user-profiles.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { isNewerSessionMention, mergeSessionProfileInvolvement } from "./session-involvement.js";
import type { SessionProfileInvolvement } from "./types.js";

/** One logical-node owner for explicit personal choices and committed mentions. */
export function updateSessionProfileInvolvement(
  scope: SessionAccessScope,
  params: {
    expectedSessionId: string;
    profileIds: readonly string[];
    change:
      | { kind: "visibility"; hidden: boolean }
      | { kind: "mention"; source: NonNullable<SessionProfileInvolvement["lastMention"]> };
    assertCurrent?: () => void;
  },
): boolean {
  const resolved = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction(
    (database) => {
      params.assertCurrent?.();
      const current = readExactSessionEntryRow(database, resolved.sessionKey)?.entry;
      if (!current || current.sessionId !== params.expectedSessionId || current.incognito) {
        return false;
      }
      const involvement = { ...current.profileInvolvement?.profiles };
      let changed = false;
      for (const profileId of new Set(params.profileIds)) {
        const aliases = readUserProfileAliases(profileId, { env: scope.env });
        const previous = mergeSessionProfileInvolvement(
          [...aliases].map((alias) => involvement[alias]),
        );
        const lastMention = previous?.lastMention;
        const change = params.change;
        // Inbox retention cannot turn an old source replay into a fresh mention.
        if (
          change.kind === "mention" &&
          lastMention &&
          !isNewerSessionMention(change.source, lastMention)
        ) {
          continue;
        }
        const hidden = change.kind === "visibility" && change.hidden;
        if (change.kind === "visibility" && previous?.hidden === hidden) {
          continue;
        }
        for (const alias of aliases) {
          delete involvement[alias];
        }
        involvement[profileId] = {
          hidden,
          updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
          ...(change.kind === "mention"
            ? { lastMention: change.source }
            : lastMention
              ? { lastMention }
              : {}),
        };
        changed = true;
      }
      if (changed) {
        writeSessionEntry(database, resolved.sessionKey, current, {
          canonicalPreviousEntry: current,
          profileInvolvement: { key: resolved.sessionKey, profiles: involvement },
        });
        deferOpenClawAgentPostCommitPublication(database, () =>
          emitSessionLifecycleEvent({
            agentId: resolved.agentId,
            sessionKey: resolved.sessionKey,
            reason: "involvement",
          }),
        );
      }
      return true;
    },
    toDatabaseOptions(resolved),
    { operationLabel: "sessions.involvement" },
  );
}
