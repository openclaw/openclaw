import type {
  RuntimeConfigWriteApplicationClaim,
  RuntimeConfigWriteApplicationStatus,
} from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  runOutsideGatewayRootWorkAdmission,
  runWithGatewayReloadWaitingRoot,
} from "../process/gateway-work-admission.js";
import type { GatewayConfigReloadCandidate } from "./config-reload.types.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

// Write-application receipts travel with config candidates until one settles them.

export function isConfigReloadSuperseded(error: unknown): boolean {
  // Only completed rollback preserves the direct cause. Cleanup failures and
  // published replacements must settle instead of transferring the write.
  const cause =
    error instanceof PluginRuntimeApplicationError && !error.details.committed
      ? error.cause
      : error;
  return cause instanceof GatewayConfigReloadSupersededError;
}

export function candidateApplications(candidate: GatewayConfigReloadCandidate | null | undefined) {
  return [candidate?.application, ...(candidate?.carriedApplications ?? [])].filter(
    (application): application is RuntimeConfigWriteApplicationClaim => application !== undefined,
  );
}

export function runWithCandidateWaitingRoots<T>(
  run: () => Promise<T>,
  candidate?: GatewayConfigReloadCandidate | null,
): Promise<T> {
  const invoke =
    captureGatewayRootWorkAdmissionContinuationScope()?.run ?? runOutsideGatewayRootWorkAdmission;
  let transaction = () => invoke(run);
  for (const application of candidateApplications(candidate)) {
    const continuation = application.runTransaction;
    if (continuation) {
      const next = transaction;
      transaction = () => continuation(() => runWithGatewayReloadWaitingRoot(next));
    }
  }
  return transaction();
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
