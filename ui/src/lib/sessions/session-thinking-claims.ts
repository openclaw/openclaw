import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCreateOutcome } from "./create.ts";
import type { readSessionChangedEvent, SessionChangedResult } from "./reconcile.ts";
import type { SessionGateway } from "./session-capability.ts";
import {
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "./session-key.ts";

/** Created thinking choices remain claimed until their canonical row catches up. */
export function createSessionThinkingClaims(
  gateway: Pick<SessionGateway, "snapshot">,
  readRequestRevision: () => number,
) {
  const claims = new Map<
    string,
    readonly [value: string, updatedAt: number | undefined, afterRevision: number]
  >();
  const claimKey = (key: string, agentId?: string | null) => {
    const ownerAgentId =
      parseAgentSessionKey(key)?.agentId ??
      agentId ??
      resolveUiSelectedGlobalAgentId(gateway.snapshot);
    return `${normalizeSessionKeyForUiComparison(key)}\0agent:${normalizeAgentId(ownerAgentId)}`;
  };

  return {
    get: (key: string, agentId?: string | null) => claims.get(claimKey(key, agentId))?.[0],
    clear: (key: string, agentId?: string | null) => claims.delete(claimKey(key, agentId)),
    reset: () => claims.clear(),
    recordCreated(key: string, entry?: SessionCreateOutcome["entry"], agentId?: string) {
      if (typeof entry?.thinkingLevel === "string" && typeof entry.updatedAt === "number") {
        claims.set(claimKey(key, agentId), [
          entry.thinkingLevel,
          entry.updatedAt,
          readRequestRevision(),
        ]);
      }
    },
    settle(row: GatewaySessionRow, requestRevision: number, agentId?: string) {
      const key = claimKey(row.key, agentId);
      const claim = claims.get(key);
      // Equal clocks need a read dispatched after the claim, not a held older response.
      const newer =
        claim?.[1] !== undefined
          ? (row.updatedAt ?? -1) > claim[1] ||
            (row.updatedAt === claim[1] && requestRevision > claim[2])
          : claim !== undefined && requestRevision > claim[2];
      if (claim && (row.thinkingLevel === claim[0] || newer)) {
        claims.delete(key);
      }
    },
    observeEvent(
      reconciled: Pick<SessionChangedResult, "applied" | "key" | "row" | "deletedKey">,
      eventInfo: ReturnType<typeof readSessionChangedEvent>,
    ): boolean {
      let claimChanged = false;
      if (reconciled.applied && reconciled.key && eventInfo) {
        const key = claimKey(reconciled.key, eventInfo.agentId);
        const claim = claims.get(key);
        const thinkingLevel = eventInfo.thinkingLevel;
        const claimEventIsCurrent =
          eventInfo.updatedAt === null ||
          claim?.[1] === undefined ||
          eventInfo.updatedAt >= claim[1];
        const removesRow =
          reconciled.deletedKey || (eventInfo.archived === true && !reconciled.row);
        if (claim && claimEventIsCurrent && removesRow) {
          claimChanged = claims.delete(key);
        } else if (
          claim &&
          claimEventIsCurrent &&
          !reconciled.row &&
          typeof thinkingLevel === "string"
        ) {
          const nextClaim = [
            thinkingLevel,
            eventInfo.updatedAt ?? undefined,
            readRequestRevision(),
          ] as const;
          claimChanged =
            claim[0] !== nextClaim[0] || claim[1] !== nextClaim[1] || claim[2] !== nextClaim[2];
          if (claimChanged) {
            claims.set(key, nextClaim);
          }
        } else if (claim && claimEventIsCurrent && thinkingLevel !== undefined) {
          claimChanged = claims.delete(key);
        }
      }
      return claimChanged;
    },
  };
}
