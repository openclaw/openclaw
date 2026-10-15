import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { isConfiguredGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  projectSessionOwner,
  projectSessionParticipants,
  projectSessionProfileInvolvements,
} from "./session-identity-projection.js";
import { compareSessionEntryPairs, type SessionEntryPair } from "./session-list-order.js";
import {
  identity as rowIdentity,
  type SelectionRow as SelectionTarget,
  type SelectionChange,
} from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { matchesSessionArchiveFilter } from "./session-utils-core.js";

const sentinel = (key: string) => key === "global" || key === "unknown";
type SelectionScope = ReturnType<SessionRowProjection["state"]["scope"]>;
const EMPTY_KEYS: ReadonlySet<string> = new Set();
type IndexedTarget = { row: SelectionTarget; pair: SessionEntryPair; position: number };

export function createSessionRowSelection(
  cfg: OpenClawConfig,
  scope: SelectionScope,
  activeOnly: boolean,
  getContext: () => SessionListRowContext,
) {
  const groups = new Map<string, Map<string, IndexedTarget>>();
  const winners = new Map<string, IndexedTarget>();
  const duplicates = new Set<string>();
  const orders = new Map<
    string,
    {
      sortBy: NonNullable<SessionsListParams["sortBy"]>;
      archived: SessionsListParams["archived"];
      entries: SessionEntryPair[];
    }
  >();
  const personalInvolvements = new Map<string, Set<string>>();
  const relatedInvolvements = new Map<string, Set<string>>();
  const rowInvolvements = new Map<string, { personal: Set<string>; related: Set<string> }>();
  const changedInvolvements = new Set<string>();
  // Store-admission scopes also include ACP IDs; owner facets use only the agent roster.
  const configuredAgentIds = scope.ownerAgentIds;
  let involvementRevision: object | undefined;
  const removeInvolvement = (key: string) => {
    const previous = rowInvolvements.get(key);
    if (!previous) {
      return;
    }
    for (const [profiles, index] of [
      [previous.personal, personalInvolvements],
      [previous.related, relatedInvolvements],
    ] as const) {
      for (const profileId of profiles) {
        const keys = index.get(profileId)!;
        keys.delete(key);
        if (!keys.size) {
          index.delete(profileId);
        }
      }
    }
    rowInvolvements.delete(key);
  };
  const prepareInvolvements = () => {
    const context = getContext();
    const revision = context.identityProjection?.revision ?? context.userProfileIdentityById;
    if (involvementRevision !== revision) {
      personalInvolvements.clear();
      relatedInvolvements.clear();
      rowInvolvements.clear();
      changedInvolvements.clear();
      for (const key of winners.keys()) {
        changedInvolvements.add(key);
      }
      involvementRevision = revision;
    }
    const identities = context.userProfileIdentityById;
    for (const key of changedInvolvements) {
      const { entry } = winners.get(key)!.row;
      const related = new Set<string>();
      const owner = (context.identityProjection?.owner ?? projectSessionOwner)(
        entry,
        identities,
        cfg,
        configuredAgentIds,
      )?.actor;
      if (owner?.identity?.type === "profile") {
        related.add(owner.identity.id);
      }
      const participants = (context.identityProjection?.participants ?? projectSessionParticipants)(
        entry,
        identities,
        cfg,
      );
      for (const participant of participants.values()) {
        if (participant.identity.type === "profile") {
          related.add(participant.identity.id);
        }
      }
      const states = (context.identityProjection?.involvement ?? projectSessionProfileInvolvements)(
        entry,
        identities,
      );
      for (const [profileId, state] of states) {
        if (state.lastMention) {
          related.add(profileId);
        }
      }
      const personal = new Set(related);
      for (const [profileId, state] of states) {
        if (state.hidden) {
          personal.delete(profileId);
        } else {
          personal.add(profileId);
        }
      }
      for (const [profiles, index] of [
        [personal, personalInvolvements],
        [related, relatedInvolvements],
      ] as const) {
        for (const profileId of profiles) {
          const keys = index.get(profileId) ?? new Set<string>();
          keys.add(key);
          index.set(profileId, keys);
        }
      }
      if (personal.size || related.size) {
        rowInvolvements.set(key, { personal, related });
      }
    }
    changedInvolvements.clear();
  };
  let position = 0;
  const keyFor = (row: Pick<SelectionTarget, "key" | "agentId">) =>
    sentinel(row.key) && activeOnly ? JSON.stringify([row.key, row.agentId]) : row.key;
  const update = (id: string, key: string, row?: SelectionTarget) => {
    const previous = groups.get(key);
    const oldWinner = winners.get(key);
    const candidate = previous?.get(id);
    const eligible =
      row &&
      scope.paths.has(row.storeTarget.storePath) &&
      (!scope.agentId || row.agentId === scope.agentId) &&
      (!scope.configuredAgentIds ||
        isConfiguredGatewaySessionEntry(cfg, scope.configuredAgentIds, row.key, row.entry));
    const group = previous ?? new Map<string, IndexedTarget>();
    if (eligible) {
      group.set(id, { row, pair: [key, row.entry], position: candidate?.position ?? position++ });
      groups.set(key, group);
    } else {
      group.delete(id);
      if (!group.size) {
        groups.delete(key);
      }
    }
    let winner: IndexedTarget | undefined;
    for (const target of group.values()) {
      if (
        !winner ||
        scope.paths.get(target.row.storeTarget.storePath)! <
          scope.paths.get(winner.row.storeTarget.storePath)!
      ) {
        winner = target;
      }
    }
    if (group.size > 1 && !sentinel(winner!.row.key)) {
      duplicates.add(key);
    } else {
      duplicates.delete(key);
    }
    if (winner) {
      winners.set(key, winner);
    } else {
      winners.delete(key);
    }
    if (winner === oldWinner) {
      return;
    }
    if (involvementRevision) {
      // Publication records only the changed metadata; identity preparation stays in the reader.
      removeInvolvement(key);
      if (winner) {
        changedInvolvements.add(key);
      } else {
        changedInvolvements.delete(key);
      }
    }
    for (const { sortBy, archived, entries } of orders.values()) {
      const locate = (pair: SessionEntryPair) => {
        let lo = 0,
          hi = entries.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (compareSessionEntryPairs(entries[mid]!, pair, sortBy) < 0) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        return lo;
      };
      if (oldWinner && matchesSessionArchiveFilter(oldWinner.row.entry, archived)) {
        entries.splice(locate(oldWinner.pair), 1);
      }
      if (winner && matchesSessionArchiveFilter(winner.row.entry, archived)) {
        entries.splice(locate(winner.pair), 0, winner.pair);
      }
    }
  };
  return {
    add(row: SelectionTarget) {
      update(rowIdentity(row), keyFor(row), row);
    },
    change(change: Exclude<SelectionChange, { kind: "reset" }>) {
      update(change.id, keyFor(change), change.row);
    },
    read(
      sortBy?: SessionsListParams["sortBy"],
      candidates?: Iterable<Pick<SelectionTarget, "key" | "agentId">>,
    ) {
      for (const key of duplicates) {
        throw canonicalSessionKeyMigrationRequiredError(
          `duplicate rows resolve to canonical session key ${key}`,
        );
      }
      return {
        configuredAgentIds,
        entries(this: void, archived: SessionsListParams["archived"]) {
          const orderKey = `${sortBy}:${archived ?? false}`;
          let entries = !candidates && sortBy && orders.get(orderKey)?.entries;
          if (!entries) {
            const targets = (
              candidates
                ? [...new Set(Array.from(candidates, keyFor))].flatMap(
                    (key) => winners.get(key) ?? [],
                  )
                : [...winners.values()]
            ).filter((target) => matchesSessionArchiveFilter(target.row.entry, archived));
            if (!sortBy) {
              targets.sort((a, b) => a.position - b.position);
            }
            entries = targets.map((target) => target.pair);
            if (sortBy) {
              entries.sort((a, b) => compareSessionEntryPairs(a, b, sortBy));
              if (!candidates) {
                orders.set(orderKey, { sortBy, archived, entries });
              }
            }
          }
          return entries;
        },
        get: (key: string) => winners.get(key)?.row,
        involvementKeys(this: void, profileId: string, personal: boolean): ReadonlySet<string> {
          prepareInvolvements();
          return (
            (personal ? personalInvolvements : relatedInvolvements).get(profileId) ?? EMPTY_KEYS
          );
        },
      };
    },
  };
}
