import type { SessionParticipantIdentity } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { SessionsListResult } from "../api/types.ts";
import { findSidebarSessionInTree } from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sessionSelfOwner, type SessionOwnerOption } from "./session-owner-chip.ts";

function sessionParticipantIdentityKey(identity: SessionParticipantIdentity): string {
  switch (identity.type) {
    case "profile":
    case "agent":
      return JSON.stringify([identity.type, identity.id]);
    case "remote":
      return JSON.stringify([
        identity.type,
        identity.pluginId,
        identity.domain,
        identity.idKind,
        identity.id,
      ]);
    case "observation":
      return JSON.stringify([
        identity.type,
        identity.pluginId,
        identity.accountId,
        identity.senderKind,
        identity.id,
      ]);
    case "legacy":
      return JSON.stringify([identity.type, identity.actorType, identity.source, identity.id]);
    default:
      return identity satisfies never;
  }
}

function hasMultipleSidebarSessionIdentities(
  ownerOptions: readonly SessionOwnerOption[],
  rows: readonly SidebarRecentSession[],
  humansOnly: boolean,
): boolean {
  const identities = new Set(
    ownerOptions
      .filter((owner) => !humansOnly || owner.type === "human")
      .map((owner) =>
        sessionParticipantIdentityKey(
          owner.identity ?? { type: owner.type === "human" ? "profile" : "agent", id: owner.id },
        ),
      ),
  );
  if (identities.size >= 2) {
    return true;
  }
  return Boolean(
    findSidebarSessionInTree(rows, (row) => {
      const participants = row.participants ?? [];
      for (const participant of participants) {
        const identity = participant.identity;
        if (
          humansOnly &&
          identity.type !== "profile" &&
          !(identity.type === "observation" && identity.senderKind === "human") &&
          !(identity.type === "legacy" && identity.actorType === "human")
        ) {
          continue;
        }
        identities.add(sessionParticipantIdentityKey(identity));
        if (identities.size >= 2) {
          return true;
        }
      }
      // Unshown participants may all be agents; only known humans enable attribution.
      return !humansOnly && (row.participantCount ?? participants.length) > participants.length;
    }),
  );
}

export function applySidebarSessionOwnerFilter(input: {
  projected: SidebarRecentSession[];
  ownerFacet: SessionsListResult["owners"];
  selectedOwnerId: string | null;
  self?: { id: string; name?: string; avatarUrl?: string } | null;
}): {
  rows: SidebarRecentSession[];
  ownerOptions: readonly SessionOwnerOption[];
  ownershipVisibility: { filters: boolean; avatars: boolean };
  activeOwnerId: string | null;
} {
  const facetOwners = input.ownerFacet ?? [];
  const selfId = input.self?.id;
  const selfOwner =
    facetOwners.find((owner) => owner.id === selfId)?.type === "agent"
      ? null
      : sessionSelfOwner(input.self);
  const ownerOptions = selfOwner
    ? [selfOwner, ...facetOwners.filter((owner) => owner.id !== selfOwner.id)]
    : facetOwners;
  const ownershipVisibility = {
    filters: hasMultipleSidebarSessionIdentities(ownerOptions, input.projected, false),
    avatars: hasMultipleSidebarSessionIdentities(ownerOptions, input.projected, true),
  };
  // An absent facet is unresolved during hydration. A present facet is the
  // Gateway's complete owner inventory, even when rows are owner-filtered.
  const selectedOwnerId = input.selectedOwnerId?.trim() || null;
  const activeOwnerId =
    selectedOwnerId &&
    (input.ownerFacet === undefined || ownerOptions.some((owner) => owner.id === selectedOwnerId))
      ? selectedOwnerId
      : null;
  if (!activeOwnerId) {
    // Involving-me is evaluated by the Gateway against the complete participant table.
    // The bounded display projection cannot safely repeat that predicate client-side.
    return {
      rows: input.projected,
      ownerOptions,
      ownershipVisibility,
      activeOwnerId,
    };
  }
  const filterTree = (treeRows: readonly SidebarRecentSession[]): SidebarRecentSession[] => {
    const filtered: SidebarRecentSession[] = [];
    for (const row of treeRows) {
      const children = filterTree(row.children);
      const ownerId = row.owner?.actor.id;
      if (ownerId === activeOwnerId) {
        filtered.push({ ...row, children });
      } else {
        for (const child of children) {
          filtered.push({ ...child, isChild: false });
        }
      }
    }
    return filtered;
  };
  return {
    rows: filterTree(input.projected),
    ownerOptions,
    ownershipVisibility,
    activeOwnerId,
  };
}
