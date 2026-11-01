import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { sessionMetadataExpectedEntryMatches } from "./session-accessor.sqlite-owner.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { isNewerSessionMention, mergeSessionProfileInvolvement } from "./session-involvement.js";
import type {
  SessionInvolvementMutation,
  SessionSharingWorkerOperations,
} from "./session-sharing-store.types.js";

/** One logical-node owner for explicit personal choices and committed mentions. */
export function updatePreparedSessionProfileInvolvement(
  scope: SessionAccessScope,
  params: SessionInvolvementMutation & { assertCurrent?: () => void },
  profiles: readonly { profileId: string; aliases: readonly string[] }[],
): SessionSharingWorkerOperations["involvement"]["output"] {
  const resolved = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction(
    (database) => {
      params.assertCurrent?.();
      const current = readExactSessionEntryRow(database, resolved.sessionKey)?.entry;
      if (!current || current.sessionId !== params.expectedSessionId || current.incognito) {
        return { accepted: false, changed: false };
      }
      if (
        params.expectedEntry &&
        !sessionMetadataExpectedEntryMatches(database, resolved.sessionKey, params.expectedEntry)
      ) {
        return { accepted: false, changed: false };
      }
      const involvement = { ...current.profileInvolvement?.profiles };
      let changed = false;
      for (const { profileId, aliases } of profiles) {
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
      return { accepted: true, changed };
    },
    toDatabaseOptions(resolved),
    { operationLabel: "sessions.involvement" },
  );
}
