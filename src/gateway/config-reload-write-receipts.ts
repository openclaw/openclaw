import type {
  RuntimeConfigWriteApplicationClaim,
  RuntimeConfigWriteApplicationStatus,
} from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayConfigReloadCandidate } from "./config-reload.types.js";

export function candidateApplications(candidate: GatewayConfigReloadCandidate | null | undefined) {
  return [candidate?.application, ...(candidate?.carriedApplications ?? [])].filter(
    (application): application is RuntimeConfigWriteApplicationClaim => application !== undefined,
  );
}

export function settleCandidateApplications(
  candidate: GatewayConfigReloadCandidate | null | undefined,
  status: RuntimeConfigWriteApplicationStatus,
) {
  for (const application of candidateApplications(candidate)) {
    // A canonical reread may already contain an external writer's replacement.
    application.settle(
      status === "applied" &&
        candidate &&
        application.isCarriedBy?.(candidate.compareConfig) === false
        ? "superseded"
        : status,
    );
  }
}

export function transferCandidateApplications(
  candidate: GatewayConfigReloadCandidate | null,
  nextConfig: OpenClawConfig | undefined,
): RuntimeConfigWriteApplicationClaim[] {
  const carried: RuntimeConfigWriteApplicationClaim[] = [];
  for (const application of candidateApplications(candidate)) {
    if (nextConfig && application.isCarriedBy?.(nextConfig)) {
      carried.push(application);
    } else {
      application.settle("superseded");
    }
  }
  if (candidate) {
    delete candidate.application;
    delete candidate.carriedApplications;
  }
  return carried;
}

export function createObservedCandidate(
  snapshot: ConfigFileSnapshot,
  epoch: number,
  previous: (GatewayConfigReloadCandidate | null)[],
): GatewayConfigReloadCandidate | null {
  const carriedApplications = [...new Set(previous)].flatMap((candidate) =>
    transferCandidateApplications(candidate, snapshot.valid ? snapshot.sourceConfig : undefined),
  );
  return carriedApplications.length > 0
    ? {
        config: snapshot.config,
        compareConfig: snapshot.sourceConfig,
        persistedHash: snapshot.hash,
        snapshot,
        epoch,
        origin: "file",
        carriedApplications,
      }
    : null;
}

export function candidateResponseSettled(
  candidate: GatewayConfigReloadCandidate | null | undefined,
): Promise<void> | undefined {
  const settlements = candidateApplications(candidate).flatMap((claim) =>
    claim.responseSettled ? [claim.responseSettled] : [],
  );
  return settlements.length > 0 ? Promise.all(settlements).then(() => {}) : undefined;
}
