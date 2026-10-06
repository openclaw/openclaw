import { createDeferredCore } from "../shared/deferred.js";
import type { ConfigWriteOptions } from "./io.types.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  hashRuntimeConfigValue,
  notifyRuntimeConfigWriteListeners,
  type ConfigWriteAfterWrite,
  type RuntimeConfigWritePreparedCandidate,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export type RuntimeConfigWriteApplicationStatus =
  | "applied"
  | "applied-restart-required"
  // Restart admission accepted the saved config; the current runtime is not updated.
  | "restart-pending"
  | "superseded"
  | "failed"
  | "stopped"
  | "unclaimed";

export type RuntimeConfigWriteApplicationClaim = {
  settle: (status: RuntimeConfigWriteApplicationStatus) => void;
  prepare?: (assertCurrent: () => void) => Promise<void>;
  requireImmediateApplication?: boolean;
  // Re-enter only the originating request root so channel drain excludes the RPC awaiting
  // this receipt; unrelated watcher reloads retain their independent transaction root.
  runTransaction?: <T>(run: () => Promise<T>) => Promise<T>;
};

type RuntimeConfigWriteApplication = {
  result: Promise<RuntimeConfigWriteApplicationStatus>;
  readonly claimed: boolean;
  claim: () => RuntimeConfigWriteApplicationClaim | null;
};

const runtimeConfigWriteApplications = new WeakMap<object, RuntimeConfigWriteApplication>();

/** Creates a single-owner receipt for one persisted config write. */
export function createRuntimeConfigWriteApplication(
  runTransaction?: <T>(run: () => Promise<T>) => Promise<T>,
  activation?: Pick<RuntimeConfigWriteApplicationClaim, "prepare" | "requireImmediateApplication">,
): RuntimeConfigWriteApplication {
  let claimed = false;
  const result = createDeferredCore<RuntimeConfigWriteApplicationStatus>();
  return {
    result: result.promise,
    get claimed() {
      return claimed;
    },
    claim: () => {
      if (claimed) {
        return null;
      }
      claimed = true;
      const claim: RuntimeConfigWriteApplicationClaim = {
        settle: (status) => {
          // Reply settlement releases the RPC root; retained watcher intent must reacquire admission.
          delete claim.runTransaction;
          result.resolve(status);
        },
        ...(runTransaction ? { runTransaction } : {}),
        ...activation,
      };
      return claim;
    },
  };
}

/** Attaches a private application receipt without changing the config notification contract. */
export function attachRuntimeConfigWriteApplication<T extends object>(
  target: T,
  application: RuntimeConfigWriteApplication | undefined,
): T {
  if (application) {
    runtimeConfigWriteApplications.set(target, application);
  }
  return target;
}

/** Copies a private application receipt when rebuilding an internal write carrier. */
export function copyRuntimeConfigWriteApplication<T extends object>(
  source: object | undefined,
  target: T,
): T {
  return attachRuntimeConfigWriteApplication(
    target,
    source ? runtimeConfigWriteApplications.get(source) : undefined,
  );
}

/** Returns the private application receipt attached to a write or notification. */
export function getRuntimeConfigWriteApplication(
  target: object,
): RuntimeConfigWriteApplication | undefined {
  return runtimeConfigWriteApplications.get(target);
}

export function publishRuntimeConfigWrite(params: {
  configPath: string;
  snapshot: ConfigFileSnapshot;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  persistedHash: string;
  deferRuntimeActivation: boolean;
  preparedCandidates: ReadonlyMap<symbol, RuntimeConfigWritePreparedCandidate>;
  writeOptions?: ConfigWriteOptions;
  afterWrite?: ConfigWriteAfterWrite;
}): void {
  const runtimeConfig = params.deferRuntimeActivation
    ? params.runtimeConfig
    : getRuntimeConfigSnapshot();
  if (!runtimeConfig) {
    return;
  }
  const preparedCandidatesByOwner = new Map(
    [...params.preparedCandidates].map(([ownerId, candidate]) => [
      ownerId,
      {
        ...candidate,
        runtimeConfig:
          candidate.reapplyRuntimeOverlays?.(params.runtimeConfig) ?? candidate.runtimeConfig,
        compareConfig:
          candidate.reapplyCompareOverlays?.(params.sourceConfig) ?? candidate.compareConfig,
      },
    ]),
  );
  const publishedMetadata = getRuntimeConfigSnapshotMetadata();
  const metadata =
    runtimeConfig === getRuntimeConfigSnapshot() && publishedMetadata
      ? publishedMetadata
      : {
          revision: publishedMetadata?.revision ?? 0,
          fingerprint: hashRuntimeConfigValue(runtimeConfig),
          sourceFingerprint: hashRuntimeConfigValue(params.sourceConfig),
          updatedAtMs: Date.now(),
        };
  notifyRuntimeConfigWriteListeners(
    copyRuntimeConfigWriteApplication(params.writeOptions, {
      configPath: params.configPath,
      snapshot: params.snapshot,
      sourceConfig: params.sourceConfig,
      runtimeConfig,
      persistedHash: params.persistedHash,
      revision: metadata.revision,
      fingerprint: metadata.fingerprint,
      sourceFingerprint: metadata.sourceFingerprint,
      writtenAtMs: Date.now(),
      afterWrite: params.afterWrite ?? params.writeOptions?.afterWrite,
      ...(params.writeOptions?.runtimeRefresh
        ? { runtimeRefresh: params.writeOptions.runtimeRefresh }
        : {}),
      ...(preparedCandidatesByOwner.size > 0 ? { preparedCandidatesByOwner } : {}),
    }),
  );
}
