import type {
  RuntimeConfigWriteApplicationClaim,
  RuntimeConfigWriteApplicationStatus,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
    application.settle(status);
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
