import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { isConfiguredGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordSessionRowPartitionRevision } from "../infra/gateway-work-metrics.js";
import {
  projectSessionOwner,
  resolveSessionProfileId,
  projectSessionProfileInvolvements,
} from "./session-identity-projection.js";
import { compareSessionEntryPairs, type SessionEntryPair } from "./session-list-order.js";
import {
  identity as rowIdentity,
  type SelectionRow as SelectionTarget,
  type SelectionChange,
} from "./session-row-projection-record.js";
import type { prepareSessionRowScopes } from "./session-row-scope.js";
import { sameSelectionFacts } from "./session-row-selection-facts.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { matchesSessionArchiveFilter } from "./session-utils-core.js";

const sentinel = (key: string) => key === "global" || key === "unknown";
type SelectionScope = ReturnType<ReturnType<typeof prepareSessionRowScopes>["select"]>;
const EMPTY_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>());
type IndexedTarget = { row: SelectionTarget; pair: SessionEntryPair };

export function createSessionRowSelection(
  cfg: OpenClawConfig,
  scope: SelectionScope,
  activeOnly: boolean,
  getContext: () => SessionListRowContext,
  indexCreators = false,
) {
  // Singleton rows live only in winners; retain physical competitors only when needed.
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
  // Fixed partitions bound refiltering after exact publications without retaining old rosters.
  let partitions: Array<{ revision: object; entries: Map<string, SessionEntryPair> }> | undefined;
  const partitionFor = (key: string) => {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
    }
    return partitions?.[hash & 63];
  };
  const personalInvolvements = new Map<string, Set<string>>();
  const relatedInvolvements = new Map<string, Set<string>>();
  const rowInvolvements = new Map<
    string,
    { personal: ReadonlySet<string>; related: ReadonlySet<string> }
  >();
  const changedInvolvements = new Set<string>();
  const creators = new Map<string, Map<string, IndexedTarget>>();
  const creatorOrders = new Map<string, IndexedTarget[]>();
  const updateCreator = (target: IndexedTarget | undefined, remove = false) => {
    const profileId = target && sessionCreatorProfileId(target.row.entry.createdActor);
    if (!indexCreators || !target || !profileId) {
      return;
    }
    const entries = creators.get(profileId) ?? new Map<string, IndexedTarget>();
    if (remove) {
      entries.delete(target.row.key);
    } else {
      entries.set(target.row.key, target);
    }
    if (entries.size) {
      creators.set(profileId, entries);
    } else {
      creators.delete(profileId);
    }
    // Retired arrays remain stable for readers awaiting repository facts.
    creatorOrders.delete(profileId);
  };
  const compareCreated = (left: IndexedTarget, right: IndexedTarget) =>
    (right.row.entry.updatedAt ?? 0) - (left.row.entry.updatedAt ?? 0) ||
    left.row.key.localeCompare(right.row.key) ||
    scope.paths.get(left.row.storeTarget.storePath)! -
      scope.paths.get(right.row.storeTarget.storePath)! ||
    Buffer.compare(Buffer.from(left.row.key), Buffer.from(right.row.key));
  const assertCanonical = () => {
    for (const key of duplicates) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${key}`,
      );
    }
  };
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
      let related: Set<string> | undefined;
      const owner = (context.identityProjection?.owner ?? projectSessionOwner)(
        entry,
        identities,
        cfg,
        configuredAgentIds,
      )?.actor;
      if (owner?.identity?.type === "profile") {
        (related ??= new Set()).add(owner.identity.id);
      }
      // Membership needs canonical IDs, not participant labels, avatars, or display map keys.
      for (const { identity } of entry.participants ?? []) {
        if (identity.type === "profile") {
          (related ??= new Set()).add(resolveSessionProfileId(identity.id, identities));
        }
      }
      const states = (context.identityProjection?.involvement ?? projectSessionProfileInvolvements)(
        entry,
        identities,
      );
      for (const [profileId, state] of states) {
        if (state.lastMention) {
          (related ??= new Set()).add(profileId);
        }
      }
      // Most rows have identical facets; copy only when a personal override changes membership.
      let personal = related;
      for (const [profileId, state] of states) {
        if (state.hidden) {
          if (personal?.has(profileId)) {
            if (personal === related) {
              personal = new Set(related);
            }
            personal.delete(profileId);
          }
        } else if (!personal?.has(profileId)) {
          if (personal === related) {
            personal = new Set(related);
          }
          (personal ??= new Set()).add(profileId);
        }
      }
      for (const [profiles, index] of [
        [personal ?? EMPTY_KEYS, personalInvolvements],
        [related ?? EMPTY_KEYS, relatedInvolvements],
      ] as const) {
        for (const profileId of profiles) {
          const keys = index.get(profileId) ?? new Set<string>();
          keys.add(key);
          index.set(profileId, keys);
        }
      }
      if (personal?.size || related?.size) {
        rowInvolvements.set(key, {
          personal: personal?.size ? personal : EMPTY_KEYS,
          related: related ?? EMPTY_KEYS,
        });
      }
    }
    changedInvolvements.clear();
  };
  const keyFor = (row: Pick<SelectionTarget, "key" | "agentId">) =>
    sentinel(row.key) && activeOnly ? JSON.stringify([row.key, row.agentId]) : row.key;
  const update = (id: string, key: string, row?: SelectionTarget, changeScope?: string) => {
    let group = groups.get(key);
    const oldWinner = winners.get(key);
    const eligible =
      row &&
      scope.paths.has(row.storeTarget.storePath) &&
      (!scope.agentId || row.agentId === scope.agentId) &&
      (!scope.configuredAgentIds ||
        isConfiguredGatewaySessionEntry(cfg, scope.configuredAgentIds, row.key, row.entry));
    if (!group && oldWinner && rowIdentity(oldWinner.row) !== id) {
      group = new Map([[rowIdentity(oldWinner.row), oldWinner]]);
    }
    let winner: IndexedTarget | undefined = eligible ? { row, pair: [key, row.entry] } : undefined;
    if (group) {
      if (winner) {
        group.set(id, winner);
      } else {
        group.delete(id);
      }
      winner = undefined;
      for (const target of group.values()) {
        if (
          !winner ||
          scope.paths.get(target.row.storeTarget.storePath)! <
            scope.paths.get(winner.row.storeTarget.storePath)!
        ) {
          winner = target;
        }
      }
      if (group.size > 1) {
        groups.set(key, group);
      } else {
        groups.delete(key);
      }
    }
    if (group && group.size > 1 && !sentinel(winner!.row.key)) {
      duplicates.add(key);
    } else {
      duplicates.delete(key);
    }
    // Raw selections without an owner snapshot still need structural comparison.
    if (
      winner &&
      oldWinner &&
      winner !== oldWinner &&
      (oldWinner.row.selectionFactsRevision && winner.row.selectionFactsRevision
        ? rowIdentity(oldWinner.row) === rowIdentity(winner.row) &&
          oldWinner.row.selectionFactsRevision === winner.row.selectionFactsRevision
        : sameSelectionFacts(oldWinner.row, winner.row))
    ) {
      oldWinner.row = winner.row;
      oldWinner.pair[1] = winner.row.entry;
      group?.set(rowIdentity(winner.row), oldWinner);
      return;
    }
    if (winner) {
      winners.set(key, winner);
    } else {
      winners.delete(key);
    }
    if (winner === oldWinner) {
      return;
    }
    updateCreator(oldWinner, true);
    updateCreator(winner);
    const partition = partitionFor(key);
    if (partition) {
      partition.revision = {};
      recordSessionRowPartitionRevision(changeScope);
      if (winner) {
        partition.entries.set(key, winner.pair);
      } else {
        partition.entries.delete(key);
      }
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
      update(change.id, keyFor(change), change.row, change.scope);
    },
    createdEntries(profileIds: ReadonlySet<string>): Iterable<SelectionTarget> {
      assertCanonical();
      const profileOrders = Array.from(profileIds, (profileId) => {
        let entries = creatorOrders.get(profileId);
        if (!entries) {
          entries = [...(creators.get(profileId)?.values() ?? [])].toSorted(compareCreated);
          creatorOrders.set(profileId, entries);
        }
        return { entries, offset: 0 };
      });
      return (function* () {
        for (;;) {
          let selected: (typeof profileOrders)[number] | undefined;
          for (const order of profileOrders) {
            const candidate = order.entries[order.offset];
            if (
              candidate &&
              (!selected || compareCreated(candidate, selected.entries[selected.offset]!) < 0)
            ) {
              selected = order;
            }
          }
          if (!selected) {
            return;
          }
          yield selected.entries[selected.offset++]!.row;
        }
      })();
    },
    read(
      sortBy?: SessionsListParams["sortBy"],
      candidates?: Iterable<Pick<SelectionTarget, "key" | "agentId">>,
      residentOrder?: Iterable<Pick<SelectionTarget, "key" | "agentId" | "storeTarget">>,
    ) {
      assertCanonical();
      if (!candidates && !partitions) {
        partitions = Array.from({ length: 64 }, () => ({
          revision: {},
          entries: new Map<string, SessionEntryPair>(),
        }));
        for (const [key, target] of winners) {
          partitionFor(key)!.entries.set(key, target.pair);
        }
      }
      return {
        configuredAgentIds,
        partitions: candidates ? undefined : partitions,
        entries(this: void, archived: SessionsListParams["archived"]) {
          const orderKey = `${sortBy}:${archived ?? false}`;
          let entries = !candidates && sortBy && orders.get(orderKey)?.entries;
          if (!entries) {
            const targets = (
              residentOrder
                ? Array.from(residentOrder, (row) => {
                    const target = winners.get(keyFor(row));
                    return target?.row.agentId === row.agentId &&
                      target.row.storeTarget.storePath === row.storeTarget.storePath
                      ? target
                      : undefined;
                  })
                : candidates
                  ? [...new Set(Array.from(candidates, keyFor))].flatMap(
                      (key) => winners.get(key) ?? [],
                    )
                  : [...winners.values()]
            ).filter(
              (target): target is IndexedTarget =>
                target !== undefined && matchesSessionArchiveFilter(target.row.entry, archived),
            );
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
