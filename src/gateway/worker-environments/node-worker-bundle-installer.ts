import { WORKER_BUNDLE_PREWARM_VERSION } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_BUNDLE_INSTALL_COMMAND } from "../../infra/node-commands.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { notifyListeners } from "../../shared/listeners.js";
import {
  parseNodeWorkerBundleInstallResult,
  type NodeWorkerBundleInstallResult,
} from "../../worker/node-bundle-install-protocol.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap-timeouts.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import type { NodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

export type GatewayNodeWorkerBundleInstallObservation = {
  nodeId: string;
  environmentIds: readonly string[];
  bundleHash: string;
  totalBytes: number;
  transferredBytes: number;
  phase: "transferring" | "installing";
  startedAtMs: number;
  updatedAtMs: number;
};

export type GatewayNodeWorkerBundleInstall = (params: {
  deviceId: string;
  environmentId: string;
  artifact: Extract<WorkerInstallationArtifact, { install: "bundle" }>;
  prewarm: boolean;
  reason: "provision" | "refresh";
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onProgress?: () => void;
}) => Promise<NodeWorkerBundleInstallResult>;

type ActiveInstall = {
  observation: GatewayNodeWorkerBundleInstallObservation;
  references: number;
  environmentReferences: Map<string, number>;
  // Callers share one node download, so every joined caller hears its progress.
  progressListeners: Set<() => void>;
  lastProgressLogAtMs: number;
  lastPublicationAtMs: number;
  serve?: {
    startedAtMs: number;
    interrupted: boolean;
  };
};

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

function sameNodeAuthority(
  left: NodeWorkerSupervisorNodeProof,
  right: NodeWorkerSupervisorNodeProof,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.pairingIdentity === right.pairingIdentity &&
    left.pairingGeneration === right.pairingGeneration &&
    left.clientId === right.clientId &&
    left.clientMode === right.clientMode &&
    left.protocolFeature === right.protocolFeature
  );
}

export function createGatewayNodeWorkerBundleInstaller(options: {
  gatewayNamespace: string;
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  transfer: NodeWorkerBundleTransferService;
  log: { info: (message: string) => void; warn: (message: string) => void };
  now?: () => number;
  onObservationChange?: (nodeId: string, environmentIds: readonly string[]) => void;
}) {
  const now = options.now ?? Date.now;
  const active = new Map<string, ActiveInstall>();
  let version = 0;
  const publish = (entry: ActiveInstall, environmentIds = entry.observation.environmentIds) => {
    entry.lastPublicationAtMs = now();
    try {
      options.onObservationChange?.(entry.observation.nodeId, environmentIds);
    } catch {
      // Session projection observers do not own installation success.
    }
    notifyListeners(entry.progressListeners, undefined);
  };
  const install: GatewayNodeWorkerBundleInstall = async (params) => {
    let startedAtMs = now();
    const prefix = `worker runtime install: node=${params.deviceId} bundle=${params.artifact.bundleHash.slice(0, 12)}`;
    const elapsedSeconds = () => Math.max(0, (now() - startedAtMs) / 1_000);
    try {
      params.signal?.throwIfAborted();
      const transport = options.getTransport();
      if (!transport) {
        throw new Error("Device worker node transport is unavailable");
      }
      // Discovery and dispatch consume one installation budget, including reconnects.
      const timeoutMs = workerBootstrapOperationTimeoutMs(params.artifact);
      const deadlineAtMs = performance.now() + timeoutMs;
      const timeout = AbortSignal.timeout(timeoutMs);
      const drain = getGatewayRestartDrainSignal();
      const signal = AbortSignal.any(
        params.signal ? [params.signal, timeout, drain] : [timeout, drain],
      );
      const assertBudgetCurrent = () => {
        signal.throwIfAborted();
        if (performance.now() >= deadlineAtMs) {
          throw new DOMException("Device worker installation deadline expired", "TimeoutError");
        }
        params.assertCurrent?.();
      };
      const assertDiscoveryCurrent = () => {
        assertBudgetCurrent();
        if (options.getTransport() !== transport) {
          throw new Error("Device worker node transport changed during installation");
        }
      };
      assertDiscoveryCurrent();
      const node = await raceNodeWorkerOperation(
        transport.waitForCurrentNode
          ? transport.waitForCurrentNode(params.deviceId, {
              signal,
              assertCurrent: assertDiscoveryCurrent,
            })
          : transport.getCurrentNode(params.deviceId),
        signal,
      );
      assertDiscoveryCurrent();
      if (!node) {
        throw new Error("Device worker node is not connected with the installer dialect");
      }
      const { artifact } = params;
      const isAuthorized = () => {
        params.assertCurrent?.();
        return (
          !signal.aborted &&
          performance.now() < deadlineAtMs &&
          options.getTransport() === transport &&
          transport.isCurrent(node)
        );
      };
      if (!isAuthorized()) {
        throw new Error("Device worker installation connection is no longer current");
      }
      const bundlePrewarm =
        params.prewarm && (node.workerHost.bundlePrewarm ?? 0) >= WORKER_BUNDLE_PREWARM_VERSION
          ? WORKER_BUNDLE_PREWARM_VERSION
          : undefined;
      const key = `${node.nodeId}:${artifact.bundleHash}`;
      let entry = active.get(key);
      if (!entry) {
        startedAtMs = now();
        entry = {
          observation: {
            nodeId: node.nodeId,
            environmentIds: [],
            bundleHash: artifact.bundleHash,
            totalBytes: artifact.tarballBytes,
            transferredBytes: 0,
            phase: "transferring",
            startedAtMs,
            updatedAtMs: startedAtMs,
          },
          references: 0,
          environmentReferences: new Map(),
          progressListeners: new Set(),
          lastProgressLogAtMs: startedAtMs,
          lastPublicationAtMs: startedAtMs,
        };
        active.set(key, entry);
        options.log.info(
          `worker runtime install started (${params.reason}): node=${node.nodeId} bundle=${artifact.bundleHash.slice(0, 12)} size=${megabytes(artifact.tarballBytes)} MB`,
        );
      }
      entry.references++;
      // A per-caller wrapper keeps shared callbacks from unsubscribing each other.
      const progressListener = params.onProgress && (() => params.onProgress?.());
      if (progressListener) {
        entry.progressListeners.add(progressListener);
      }
      const environmentReferences = entry.environmentReferences.get(params.environmentId) ?? 0;
      entry.environmentReferences.set(params.environmentId, environmentReferences + 1);
      if (environmentReferences === 0) {
        entry.observation = {
          ...entry.observation,
          environmentIds: [...entry.environmentReferences.keys()],
        };
        version++;
        publish(entry);
      } else if (progressListener) {
        // Joining an environment's in-flight install is progress even without a new publication.
        notifyListeners([progressListener], undefined);
      }
      const currentEntry = entry;
      startedAtMs = currentEntry.observation.startedAtMs;
      let prepared: ReturnType<NodeWorkerBundleTransferService["prepare"]> | undefined;
      let serve: ActiveInstall["serve"];
      try {
        prepared = options.transfer.prepare({
          gatewayNamespace: options.gatewayNamespace,
          artifact,
          ...(bundlePrewarm ? { bundlePrewarm } : {}),
          isAuthorized,
          signal,
          onProgress: (servedBytes) => {
            const updatedAtMs = now();
            if (serve?.interrupted) {
              serve = undefined;
            } else if (serve && currentEntry.serve !== serve) {
              return;
            }
            serve ??= { startedAtMs: updatedAtMs, interrupted: false };
            const serveChanged = currentEntry.serve !== serve;
            if (serveChanged) {
              if (currentEntry.serve?.interrupted) {
                options.log.info(`${prefix} transfer restarted`);
              }
              currentEntry.serve = serve;
              currentEntry.lastProgressLogAtMs = updatedAtMs;
            }
            const observation = currentEntry.observation;
            const transferredBytes = Math.min(observation.totalBytes, servedBytes);
            // A retry or queued invoke can serve a fresh archive after its predecessor fails.
            // Progress belongs to that serve, not the maximum of all attempts.
            if (!serveChanged && transferredBytes <= observation.transferredBytes) {
              return;
            }
            const transferSeconds = Math.max(0, (updatedAtMs - serve.startedAtMs) / 1_000);
            const phase =
              transferredBytes === observation.totalBytes ? "installing" : "transferring";
            const phaseChanged = phase !== observation.phase;
            currentEntry.observation = { ...observation, transferredBytes, updatedAtMs, phase };
            version++;
            if (phase === "installing" && (phaseChanged || serveChanged)) {
              options.log.info(
                `${prefix} transfer complete after ${transferSeconds.toFixed(1)}s; node is installing`,
              );
            } else if (updatedAtMs - currentEntry.lastProgressLogAtMs >= 30_000) {
              currentEntry.lastProgressLogAtMs = updatedAtMs;
              const bytesPerSecond = transferredBytes / Math.max(1, transferSeconds);
              const rate =
                bytesPerSecond >= 1_000_000
                  ? `${megabytes(bytesPerSecond)} MB/s`
                  : `${(bytesPerSecond / 1_000).toFixed(1)} KB/s`;
              options.log.info(
                `${prefix} ${megabytes(transferredBytes)}/${megabytes(observation.totalBytes)} MB (${Math.round((transferredBytes / observation.totalBytes) * 100)}%) ${rate}`,
              );
            }
            if (
              serveChanged ||
              phaseChanged ||
              updatedAtMs - currentEntry.lastPublicationAtMs >= 2_000
            ) {
              publish(currentEntry);
            }
          },
          onInterrupted: (servedBytes, reason) => {
            if (serve?.interrupted) {
              return;
            }
            serve ??= { startedAtMs: now(), interrupted: false };
            serve.interrupted = true;
            currentEntry.serve ??= serve;
            options.log.warn(
              `${prefix} transfer interrupted at ${megabytes(Math.min(artifact.tarballBytes, servedBytes))}/${megabytes(artifact.tarballBytes)} MB: ${reason}`,
            );
          },
        });
        const result = await raceNodeWorkerOperation(
          transport.invoke({
            node,
            command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
            params: prepared.input,
            timeoutMs: Math.ceil(deadlineAtMs - performance.now()),
            idempotencyKey: `${options.gatewayNamespace}:${artifact.bundleHash}`,
            isDispatchAuthorized: isAuthorized,
            signal,
            onDispatchReady: (invokeId) => {
              try {
                options.log.info(
                  `${prefix} invoke dispatched: environment=${params.environmentId} conn=${node.connId} invoke=${invokeId} remoteEffects=unknown`,
                );
              } catch {
                // Logging is not installation authority or a node acknowledgement.
              }
            },
          }),
          signal,
        );
        assertBudgetCurrent();
        if (!isAuthorized()) {
          const replacement =
            options.getTransport() === transport
              ? await raceNodeWorkerOperation(transport.getCurrentNode(params.deviceId), signal)
              : undefined;
          assertBudgetCurrent();
          if (
            options.getTransport() !== transport ||
            replacement === undefined ||
            !sameNodeAuthority(node, replacement) ||
            !transport.isCurrent(replacement)
          ) {
            throw new Error("Device worker installation connection is no longer current");
          }
        }
        if (!result.ok) {
          throw new Error(
            result.error?.message
              ? `Device worker bundle installation failed: ${result.error.message}`
              : "Device worker bundle installation failed",
          );
        }
        let payload: unknown = result.payload;
        if (result.payloadJSON) {
          try {
            payload = JSON.parse(result.payloadJSON) as unknown;
          } catch {
            payload = undefined;
          }
        }
        const receipt = parseNodeWorkerBundleInstallResult(payload);
        if (!receipt || !sameWorkerBuild(receipt, artifact)) {
          throw new Error("Device worker bundle installer returned a mismatched build receipt");
        }
        if (currentEntry.references === 1) {
          options.log.info(`${prefix} installed in ${elapsedSeconds().toFixed(1)}s`);
        }
        return receipt;
      } finally {
        if (prepared) {
          options.transfer.revoke(prepared.token);
        }
        currentEntry.references--;
        if (progressListener) {
          currentEntry.progressListeners.delete(progressListener);
        }
        const remaining = currentEntry.environmentReferences.get(params.environmentId)! - 1;
        if (remaining === 0) {
          currentEntry.environmentReferences.delete(params.environmentId);
          currentEntry.observation = {
            ...currentEntry.observation,
            environmentIds: [...currentEntry.environmentReferences.keys()],
          };
          if (currentEntry.references === 0) {
            active.delete(key);
          }
          version++;
          // The released environment may have no node binding yet; name it so its projection clears.
          publish(currentEntry, [...currentEntry.observation.environmentIds, params.environmentId]);
        } else {
          currentEntry.environmentReferences.set(params.environmentId, remaining);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log.warn(`${prefix} failed after ${elapsedSeconds().toFixed(1)}s: ${message}`);
      throw error;
    }
  };
  const readInstall = (matches: (entry: ActiveInstall) => boolean) => {
    let latest: GatewayNodeWorkerBundleInstallObservation | undefined;
    for (const entry of active.values()) {
      if (matches(entry) && (!latest || entry.observation.updatedAtMs >= latest.updatedAtMs)) {
        latest = entry.observation;
      }
    }
    return latest ? { ...latest, environmentIds: [...latest.environmentIds] } : undefined;
  };
  return Object.assign(install, {
    readInstall: (nodeId: string) => readInstall((entry) => entry.observation.nodeId === nodeId),
    readInstallForEnvironment: (environmentId: string) =>
      readInstall((entry) => entry.environmentReferences.has(environmentId)),
    version: () => version,
  });
}
