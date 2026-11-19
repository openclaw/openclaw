import type {
  RuntimeConfigWriteApplicationClaim,
  RuntimeConfigWriteApplicationStatus,
} from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  runOutsideGatewayRootWorkAdmission,
  runWithGatewayReloadWaitingRoot,
} from "../process/gateway-work-admission.js";
import type {
  GatewayConfigReloadCandidate,
  GatewayConfigReloaderOptions,
} from "./config-reload.types.js";
import { PluginAdmittedWorkDeferredError } from "./server-plugin-reload-cleanup.js";
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

export function isDeferredPluginApplication(
  error: unknown,
): error is PluginRuntimeApplicationError & { cause: PluginAdmittedWorkDeferredError } {
  return (
    error instanceof PluginRuntimeApplicationError &&
    !error.details.committed &&
    error.cause instanceof PluginAdmittedWorkDeferredError
  );
}

export async function promoteAcceptedConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  reason: string,
  opts: Pick<GatewayConfigReloaderOptions, "promoteSnapshot" | "log">,
) {
  if (!opts.promoteSnapshot || !snapshot.exists || !snapshot.valid) {
    return;
  }
  try {
    await opts.promoteSnapshot(snapshot, reason);
  } catch (err) {
    opts.log.warn(`config reload last-known-good promotion failed: ${String(err)}`);
  }
}

/** Settle saved-write receipts without keeping their requesting turns alive. */
export function reportConfigReloadFailure(params: {
  error: unknown;
  candidate: GatewayConfigReloadCandidate | null;
  retry: AbortController | undefined;
  signal: AbortSignal;
  onIdle: () => void;
  log: GatewayConfigReloaderOptions["log"];
}): AbortController | undefined {
  const { error, candidate, retry, signal, onIdle, log } = params;
  const deferred = isDeferredPluginApplication(error) ? error.cause : undefined;
  if (!deferred) {
    settleCandidateApplications(candidate, "failed");
    log.error(`config reload failed: ${String(error)}`);
    return retry;
  }
  settleCandidateApplications(candidate, {
    status: "deferred",
    reason: deferred.message,
    appliesWhen:
      "After the retained plugin work finishes, or after a Gateway restart. The previous plugin configuration remains active until then.",
  });
  if (retry) {
    return retry;
  }
  const observation = new AbortController();
  const retrySignal = AbortSignal.any([signal, observation.signal]);
  void Promise.all([
    ...deferred.instances.map((instance) => instance.waitForIdle(retrySignal)),
    ...deferred.retirements.map((retirement) =>
      racePromiseWithAbortSignal(retirement, retrySignal),
    ),
  ]).then(
    () => {
      if (!retrySignal.aborted) {
        onIdle();
      }
    },
    () => {
      // Cancellation ends this observation, not the serving plugin's work.
    },
  );
  log.info(
    `config reload deferred: ${String(error)}; retrying automatically after admitted work and cleanup settle`,
  );
  return observation;
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
