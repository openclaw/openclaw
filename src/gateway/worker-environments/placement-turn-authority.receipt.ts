import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
  type SqliteCommittedFact,
} from "../../infra/sqlite-commit-receipt.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type {
  ClaimChange,
  PlacementAuthorityOwner,
  WorkspaceResultPostimage,
} from "./placement-turn-authority.types.js";

/** Native invalidators remain unknown until their owner can capture a complete postimage. */
export function capturePlacementAuthorityChange(
  owner: PlacementAuthorityOwner,
  change: ClaimChange,
) {
  const source = { identity: owner.identity.key, incarnation: owner.incarnation };
  const domain = `worker-placement-${change.kind}`;
  let fact: SqliteCommittedFact<ClaimChange>;
  if (
    (change.kind === "claim" && change.retired) ||
    (change.kind === "workspace-result" && change.cleared) ||
    (change.kind === "journal" && change.present === false) ||
    (change.kind === "tools" && !change.authority)
  ) {
    fact = { kind: "absent" };
  } else if (
    change.kind === "tools" ||
    (change.kind === "journal" ? change.present === true : change.facts)
  ) {
    fact = { kind: "postimage", value: change };
  } else {
    fact = { kind: "unknown" };
  }
  const receipt = createSqliteCommitReceipt({
    source,
    domain,
    keys: [change.sessionId],
    readFact: () => fact,
  });
  return () => {
    if (
      !hasSqliteCommitReceiptCoverage(receipt, {
        source: { identity: owner.identity.key, incarnation: owner.incarnation },
        domain,
        keys: [change.sessionId],
      })
    ) {
      throw new Error("Placement publication changed owner or coverage");
    }
    const committed = receipt.facts.get(change.sessionId)!;
    return committed.kind === "postimage" ? committed.value : change;
  };
}

export function captureWorkspaceResultPostimage(
  sessionId: string,
  facts?: WorkspaceResultPostimage,
): WorkspaceResultPostimage | undefined {
  if (
    facts &&
    (facts.placement.sessionId !== sessionId ||
      (facts.pendingResult && facts.pendingResult.sessionId !== sessionId))
  ) {
    throw new Error("Workspace result publication has a different session owner");
  }
  return freezeJsonSnapshot(facts);
}

export function captureWorkspaceResultChange(
  sessionId: string,
  facts?: WorkspaceResultPostimage | null,
): Extract<ClaimChange, { kind: "workspace-result" }> {
  return {
    kind: "workspace-result",
    sessionId,
    ...(facts === null
      ? { cleared: true }
      : { facts: captureWorkspaceResultPostimage(sessionId, facts) }),
  };
}
