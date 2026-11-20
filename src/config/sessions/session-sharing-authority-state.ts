import { matchesAgentDatabaseReadCandidatePath } from "../../infra/agent-database-readers.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";

export const unknownSharingAuthorities = resolveGlobalMap<
  string,
  { owner?: object; reason?: string; reconciliation?: { path: string; run: () => Promise<void> } }
>(Symbol.for("openclaw.unknownSessionSharingAuthorities"), "close-and-restart");

/** Diagnostics read the authority owner's denial without exposing physical database identities. */
export function readSessionSharingAuthorityHealth(includeSensitive: boolean) {
  if (unknownSharingAuthorities.size === 0) {
    return undefined;
  }
  const sessionKeys = [
    ...new Set(
      [...unknownSharingAuthorities.keys()].map((key) => key.slice(key.indexOf("\0") + 1)),
    ),
  ].toSorted();
  return {
    restartRequired: true,
    affectedSessionCount: sessionKeys.length,
    ...(includeSensitive ? { sessionKeys } : {}),
    recovery: "Restart the Gateway to clear unknown session sharing authority.",
    reasons: [
      ...new Set(
        [...unknownSharingAuthorities.values()].map((marker) => marker.reason ?? "unsettled"),
      ),
    ].toSorted(),
  };
}

/** Capture only denials created by this publication, not an earlier conflicting outcome. */
export function captureSessionSharingAuthorityReconciliation(
  databaseIdentity: string,
  sessionKeys: readonly string[],
  owner: object,
) {
  const selected = sessionKeys.flatMap((sessionKey) => {
    const key = `file:${databaseIdentity}\0${sessionKey}`;
    const marker = unknownSharingAuthorities.get(key);
    return marker?.owner === owner ? [{ key, marker, sessionKey }] : [];
  });
  return {
    sessionKeys: selected.map(({ sessionKey }) => sessionKey),
    deny(reason: string) {
      for (const { key, marker } of selected) {
        if (unknownSharingAuthorities.get(key) === marker) {
          marker.reason = reason;
        }
      }
    },
    prepare(path: string, run: () => Promise<void>) {
      const reconciliation = { path, run };
      for (const { key, marker } of selected) {
        if (unknownSharingAuthorities.get(key) === marker) {
          marker.reconciliation = reconciliation;
          marker.reason = "reconciliation-pending";
        }
      }
    },
    settle() {
      for (const { key, marker } of selected) {
        if (unknownSharingAuthorities.get(key) === marker) {
          unknownSharingAuthorities.delete(key);
        }
      }
    },
  };
}

/** A new acquisition can consume one settled owner's recovery, never a retained grant. */
export function reconcileSessionSharingAuthoritiesBeforeAcquisition(
  logicalPaths: Iterable<string>,
  sessionKeys: readonly string[],
): Promise<void> | undefined {
  const candidates = [...logicalPaths].map((path) => {
    const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(path);
    return Object.assign(
      { path: target.path },
      !target.agentId && !target.shared ? { scope: "sibling-family" as const } : {},
    );
  });
  const recoveries = new Set<{ path: string; run: () => Promise<void> }>();
  for (const [key, marker] of unknownSharingAuthorities) {
    const recovery = marker.reconciliation;
    if (
      recovery &&
      candidates.some((candidate) =>
        matchesAgentDatabaseReadCandidatePath(candidate, recovery.path),
      ) &&
      sessionKeys.includes(key.slice(key.indexOf("\0") + 1))
    ) {
      recoveries.add(recovery);
    }
  }
  if (recoveries.size === 0) {
    return undefined;
  }
  // Claim the whole selection before yielding; a sibling acquisition cannot replay a later item.
  for (const marker of unknownSharingAuthorities.values()) {
    if (marker.reconciliation && recoveries.has(marker.reconciliation)) {
      delete marker.reconciliation;
      marker.reason = "reconciling";
    }
  }
  return (async () => {
    for (const recovery of recoveries) {
      await recovery.run();
    }
  })();
}
