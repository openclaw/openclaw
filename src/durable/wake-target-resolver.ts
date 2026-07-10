import type {
  DurableWakeOwnerKind,
  DurableWakeTargetKind,
  DurableWakeTargetResolutionStatus,
} from "./types.js";

export type DurableWakeTargetCandidate = {
  kind: DurableWakeTargetKind;
  ref: string;
  ownerKind?: DurableWakeOwnerKind;
  ownerRef?: string;
  reportRouteRef?: string;
  agentKey?: string;
  sessionKey?: string;
  live?: boolean;
  authorized?: boolean;
  external?: boolean;
};

export type DurableWakeDelegationKind =
  | "subagent_child"
  | "peer_delegation"
  | "scheduled_job"
  | "taskflow_node"
  | "background_work";

export type DurableWakeDelegationFact = {
  kind: DurableWakeDelegationKind;
  parent?: DurableWakeTargetCandidate;
  supervisor?: DurableWakeTargetCandidate;
  delegator?: DurableWakeTargetCandidate;
  coordinator?: DurableWakeTargetCandidate;
  owner?: DurableWakeTargetCandidate;
  reportRoute?: DurableWakeTargetCandidate;
};

export type DurableWakeTargetResolutionFacts = {
  sourceRunId?: string;
  directTurnOwner?: DurableWakeTargetCandidate;
  explicitWorkOwners?: DurableWakeTargetCandidate[];
  delegations?: DurableWakeDelegationFact[];
  scheduledOwner?: DurableWakeTargetCandidate;
  reportRoute?: DurableWakeTargetCandidate;
  requester?: DurableWakeTargetCandidate;
  rootOwner?: DurableWakeTargetCandidate;
  operatorRoute?: DurableWakeTargetCandidate;
};

export type DurableWakeResolvedTarget = {
  status: DurableWakeTargetResolutionStatus;
  target?: DurableWakeTargetCandidate;
  targetKind?: DurableWakeTargetKind;
  targetRef?: string;
  ownerKind?: DurableWakeOwnerKind;
  ownerRef?: string;
  reportRouteRef?: string;
  resolutionReason: string;
  diagnostics: string[];
};

type CandidateTier = {
  reason: string;
  candidates: DurableWakeTargetCandidate[];
  authoritative?: boolean;
  ordered?: boolean;
};

function compactCandidates(
  candidates: Array<DurableWakeTargetCandidate | undefined>,
): DurableWakeTargetCandidate[] {
  return candidates.filter((candidate): candidate is DurableWakeTargetCandidate => {
    return Boolean(candidate?.kind && candidate.ref);
  });
}

function isLive(candidate: DurableWakeTargetCandidate): boolean {
  return candidate.live !== false;
}

function isAuthorized(candidate: DurableWakeTargetCandidate): boolean {
  return candidate.authorized !== false;
}

function targetFromCandidate(
  status: DurableWakeTargetResolutionStatus,
  candidate: DurableWakeTargetCandidate,
  resolutionReason: string,
  diagnostics: string[] = [],
): DurableWakeResolvedTarget {
  return {
    status,
    target: candidate,
    targetKind: candidate.kind,
    targetRef: candidate.ref,
    ...(candidate.ownerKind ? { ownerKind: candidate.ownerKind } : {}),
    ...(candidate.ownerRef ? { ownerRef: candidate.ownerRef } : {}),
    ...(candidate.reportRouteRef ? { reportRouteRef: candidate.reportRouteRef } : {}),
    resolutionReason,
    diagnostics,
  };
}

function unresolvedResult(
  status: Exclude<DurableWakeTargetResolutionStatus, "resolved" | "unresolved">,
  resolutionReason: string,
  diagnostics: string[],
  operatorRoute?: DurableWakeTargetCandidate,
): DurableWakeResolvedTarget {
  if (operatorRoute && isAuthorized(operatorRoute) && isLive(operatorRoute)) {
    return targetFromCandidate(status, operatorRoute, resolutionReason, diagnostics);
  }
  return {
    status: "inspect_only",
    targetKind: "inspect_only",
    targetRef: "inspect_only",
    resolutionReason,
    diagnostics,
  };
}

function delegationCandidates(delegation: DurableWakeDelegationFact): DurableWakeTargetCandidate[] {
  switch (delegation.kind) {
    case "subagent_child":
      return compactCandidates([
        delegation.parent,
        delegation.supervisor,
        delegation.reportRoute,
        delegation.coordinator,
      ]);
    case "peer_delegation":
      return compactCandidates([
        delegation.coordinator,
        delegation.delegator,
        delegation.owner,
        delegation.reportRoute,
      ]);
    case "scheduled_job":
    case "taskflow_node":
    case "background_work":
      return compactCandidates([
        delegation.owner,
        delegation.coordinator,
        delegation.reportRoute,
        delegation.supervisor,
      ]);
  }
}

function buildCandidateTiers(facts: DurableWakeTargetResolutionFacts): CandidateTier[] {
  const tiers: CandidateTier[] = [];
  const explicitWorkOwners = compactCandidates(facts.explicitWorkOwners ?? []);
  if (explicitWorkOwners.length > 0) {
    tiers.push({
      reason: "explicit_work_owner",
      candidates: explicitWorkOwners,
      authoritative: true,
    });
  }
  const directTurnOwner = compactCandidates([facts.directTurnOwner]);
  if (directTurnOwner.length > 0) {
    tiers.push({ reason: "direct_turn_owner", candidates: directTurnOwner });
  }
  for (const delegation of facts.delegations ?? []) {
    tiers.push({
      reason: `delegation_${delegation.kind}`,
      candidates: delegationCandidates(delegation),
      ordered: true,
    });
  }
  const scheduledOwner = compactCandidates([facts.scheduledOwner]);
  if (scheduledOwner.length > 0) {
    tiers.push({ reason: "scheduled_or_background_owner", candidates: scheduledOwner });
  }
  const reportRoute = compactCandidates([facts.reportRoute]);
  if (reportRoute.length > 0) {
    tiers.push({ reason: "report_route", candidates: reportRoute });
  }
  const requester = compactCandidates([facts.requester]);
  if (requester.length > 0) {
    tiers.push({ reason: "requester_route", candidates: requester });
  }
  const rootOwner = compactCandidates([facts.rootOwner]);
  if (rootOwner.length > 0) {
    tiers.push({ reason: "root_owner_fallback", candidates: rootOwner });
  }
  return tiers;
}

export function resolveDurableWakeTarget(
  facts: DurableWakeTargetResolutionFacts,
): DurableWakeResolvedTarget {
  const diagnostics: string[] = [];
  for (const tier of buildCandidateTiers(facts)) {
    if (tier.ordered) {
      for (const candidate of tier.candidates) {
        if (!isAuthorized(candidate)) {
          return unresolvedResult(
            "unauthorized",
            `${tier.reason}_unauthorized`,
            [...diagnostics, `${tier.reason}: ordered target is not authorized`],
            facts.operatorRoute,
          );
        }
        if (!isLive(candidate)) {
          diagnostics.push(`${tier.reason}: ordered target is not live`);
          continue;
        }
        return targetFromCandidate("resolved", candidate, tier.reason, diagnostics);
      }
      if (tier.candidates.length > 0) {
        diagnostics.push(`${tier.reason}: no live authorized target`);
      }
      continue;
    }
    const liveAuthorized = tier.candidates.filter((candidate) => {
      return isLive(candidate) && isAuthorized(candidate);
    });
    const unauthorized = tier.candidates.filter((candidate) => !isAuthorized(candidate));
    if (unauthorized.length > 0 && tier.authoritative) {
      return unresolvedResult(
        "unauthorized",
        `${tier.reason}_unauthorized`,
        [...diagnostics, `${tier.reason}: authoritative owner is not authorized`],
        facts.operatorRoute,
      );
    }
    if (liveAuthorized.length === 1) {
      const candidate = liveAuthorized[0];
      if (!candidate) {
        continue;
      }
      return targetFromCandidate("resolved", candidate, tier.reason, diagnostics);
    }
    if (liveAuthorized.length > 1) {
      return unresolvedResult(
        "ambiguous",
        `${tier.reason}_ambiguous`,
        [...diagnostics, `${tier.reason}: multiple live authorized targets`],
        facts.operatorRoute,
      );
    }
    if (tier.authoritative) {
      return unresolvedResult(
        "missing",
        `${tier.reason}_missing`,
        [...diagnostics, `${tier.reason}: authoritative owner is not live or missing`],
        facts.operatorRoute,
      );
    }
    if (tier.candidates.length > 0) {
      diagnostics.push(`${tier.reason}: no live authorized target`);
    }
  }
  if (facts.operatorRoute && isAuthorized(facts.operatorRoute) && isLive(facts.operatorRoute)) {
    return targetFromCandidate(
      "inspect_only",
      facts.operatorRoute,
      "operator_inspect_only_fallback",
      diagnostics,
    );
  }
  return {
    status: "inspect_only",
    targetKind: "inspect_only",
    targetRef: "inspect_only",
    resolutionReason: "no_handler_inspect_only",
    diagnostics,
  };
}
