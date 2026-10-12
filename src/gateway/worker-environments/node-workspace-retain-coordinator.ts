import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_WORKSPACE_RETAIN_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_WORKER_BUNDLE_RETENTION_VERSION,
  NODE_WORKER_BUNDLE_STATUS_VERSION,
} from "../../infra/node-runner-inventory.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES,
  NODE_WORKER_RETAIN_REQUEST_MAX_BYTES,
  parseNodeWorkerWorkspaceRetainResult,
  type NodeWorkerWorkspaceRetainEntry,
  type NodeWorkerWorkspaceRetainInput,
} from "../../worker/node-workspace-retain-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { parseNodeWorkerResponse } from "./node-worker-response.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import { isTerminalWorkerEnvironmentState } from "./state.js";
import { listRetainedWorkerBundleHashes } from "./worker-bundle-retention.js";

const RETAIN_COMMAND_TIMEOUT_MS = 10 * 60_000;

export type NodeWorkerBundleRetention = {
  currentBuild: () => Promise<
    Readonly<Pick<WorkerAdmissionHandshake, "bundleHash" | "openclawVersion">>
  >;
  isEnvironmentOwnedNode: (nodeId: string) => boolean;
};

type NodeWorkspaceRetainCoordinatorOptions = {
  gatewayNamespace: string;
  placements: Pick<
    WorkerSessionPlacementStore,
    "prepareMaintenancePlacements" | "prepareRuntimeRefresh"
  >;
  environments: Pick<WorkerEnvironmentService, "list">;
  bundleRetention?: NodeWorkerBundleRetention;
  additionalManifestRefs?: (
    placement: WorkerSessionPlacementRecord,
  ) => Promise<() => readonly string[] | null>;
  warn: (message: string) => void;
};

type PreparedManifestRefs = ReadonlyMap<string, () => readonly string[] | null>;
type PreparedPlacement = Awaited<ReturnType<WorkerSessionPlacementStore["prepareRuntimeRefresh"]>>;
type PreparedPlacementFacts = ReadonlyMap<string, PreparedPlacement>;

function nodeEnvironments(options: NodeWorkspaceRetainCoordinatorOptions, nodeId: string) {
  return options.environments.list().filter((environment) => environment.nodeDeviceId === nodeId);
}

function bundleStatusTargetForNode(options: NodeWorkspaceRetainCoordinatorOptions, nodeId: string) {
  return nodeEnvironments(options, nodeId)
    .filter(
      (environment) =>
        environment.bootstrapReceipt !== null &&
        !isTerminalWorkerEnvironmentState(environment.state),
    )
    .toSorted(
      (left, right) =>
        right.createdAtMs - left.createdAtMs ||
        left.environmentId.localeCompare(right.environmentId),
    )[0]?.bootstrapReceipt;
}

function snapshotEntriesForNode(
  options: NodeWorkspaceRetainCoordinatorOptions,
  nodeId: string,
  preparedManifestRefs: PreparedManifestRefs,
  preparedPlacements: PreparedPlacementFacts,
): NodeWorkerWorkspaceRetainEntry[] {
  return nodeEnvironments(options, nodeId)
    .flatMap((environment): NodeWorkerWorkspaceRetainEntry[] => {
      if (
        isTerminalWorkerEnvironmentState(environment.state) ||
        environment.attachedSessionIds.length !== 1
      ) {
        return [];
      }
      const sessionId = environment.attachedSessionIds[0]!;
      const facts = preparedPlacements.get(sessionId);
      facts?.assertCurrent();
      const placement = facts?.placement;
      const pending = facts?.pendingResult;
      // The base is not a complete reachability set until reconciliation settles. Pending
      // results preserve this protection across restarts, when node-local transfer pins are lost.
      const unsettled =
        !facts ||
        placement?.turnClaim ||
        (pending?.environmentId === environment.environmentId &&
          pending.ownerEpoch === environment.ownerEpoch);
      const hasExactManifestOwner =
        placement?.state === "starting" ||
        placement?.state === "active" ||
        placement?.state === "draining" ||
        placement?.state === "reconciling";
      const additional =
        hasExactManifestOwner &&
        !unsettled &&
        placement.environmentId === environment.environmentId &&
        placement.workspaceBaseManifestRef &&
        (placement.activeOwnerEpoch === environment.ownerEpoch || placement.state === "starting")
          ? options.additionalManifestRefs
            ? (preparedManifestRefs.get(sessionId)?.() ?? null)
            : []
          : null;
      const exactManifest =
        additional !== null && placement?.workspaceBaseManifestRef
          ? [...new Set([placement.workspaceBaseManifestRef, ...additional])].toSorted()
          : null;
      return [
        {
          environmentId: environment.environmentId,
          sessionId,
          generation: environment.ownerEpoch,
          manifestRefs: exactManifest,
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.environmentId.localeCompare(right.environmentId) ||
        left.sessionId.localeCompare(right.sessionId) ||
        left.generation - right.generation,
    );
}

export function createNodeWorkspaceRetainCoordinator(
  options: NodeWorkspaceRetainCoordinatorOptions,
) {
  const controllerId = randomUUID();
  const abortController = new AbortController();
  const pendingNodes = new Set<string | undefined>();
  const acknowledgedBundleGenerationByNode = new Map<
    string,
    { connId: string; generation: number }
  >();
  let transport: NodeWorkerSupervisorTransport | undefined;
  let sequence = 0;
  const operations = new Map<string | undefined, Promise<void>>();
  let started = false;
  let stopped = false;

  const publishPreparedSnapshot = async (
    currentTransport: NodeWorkerSupervisorTransport,
    node: NodeWorkerSupervisorNodeProof,
    preparedPlacements: PreparedPlacementFacts,
  ): Promise<void> => {
    // Environment-owned cloud nodes prepare under their enrollment/mode owner.
    // Persistent hosts keep the current build when installed; maintenance never installs it.
    const bundleRetention = options.bundleRetention;
    const bundleRetentionSupported =
      node.workerHost.bundleRetention === NODE_WORKER_BUNDLE_RETENTION_VERSION;
    let bundlePreparationError: string | undefined;
    const currentBuild =
      bundleRetentionSupported && bundleRetention
        ? await bundleRetention.currentBuild().catch((error: unknown) => {
            bundlePreparationError = error instanceof Error ? error.message : String(error);
            return undefined;
          })
        : undefined;
    const hostBuild =
      bundleRetention && !bundleRetention.isEnvironmentOwnedNode(node.nodeId)
        ? currentBuild
        : undefined;
    const isCurrent = () =>
      !stopped &&
      transport === currentTransport &&
      currentTransport.isCurrent(node) &&
      (!hostBuild || !bundleRetention?.isEnvironmentOwnedNode(node.nodeId));
    const preparedManifestRefs = new Map<string, () => readonly string[] | null>();
    if (options.additionalManifestRefs) {
      const environmentIds = new Set(
        nodeEnvironments(options, node.nodeId).map((environment) => environment.environmentId),
      );
      for (const { placement } of preparedPlacements.values()) {
        if (placement?.environmentId && environmentIds.has(placement.environmentId)) {
          const current = await options.additionalManifestRefs(placement);
          preparedManifestRefs.set(placement.sessionId, current);
        }
      }
    }
    const inventory = await options.placements.prepareMaintenancePlacements();
    try {
      inventory.assertCurrent();
    } finally {
      inventory.release();
    }
    const environments = nodeEnvironments(options, node.nodeId);
    // Provisioning and refresh install before recording receipts. Keep the current build until
    // every live environment records it, so an acknowledged generation cannot prune it.
    const retainCurrentBuild =
      currentBuild &&
      (hostBuild ||
        environments.some(
          (environment) =>
            !isTerminalWorkerEnvironmentState(environment.state) &&
            environment.bootstrapReceipt?.bundleHash !== currentBuild.bundleHash,
        ));
    const environmentIds = new Set(environments.map((environment) => environment.environmentId));
    const retainedBundleHashes = [
      ...new Set([
        ...listRetainedWorkerBundleHashes({
          environments,
          placements: inventory.placements.filter(
            (placement) =>
              placement.environmentId !== null && environmentIds.has(placement.environmentId),
          ),
        }),
        ...(retainCurrentBuild ? [currentBuild.bundleHash] : []),
      ]),
    ].toSorted();
    const baseInput: NodeWorkerWorkspaceRetainInput = {
      version: 1,
      gatewayNamespace: options.gatewayNamespace,
      controllerId,
      sequence: (sequence += 1),
      retain: snapshotEntriesForNode(
        options,
        node.nodeId,
        preparedManifestRefs,
        preparedPlacements,
      ),
    };
    const priorGeneration = acknowledgedBundleGenerationByNode.get(node.nodeId);
    const acknowledgedBundleGeneration =
      priorGeneration?.connId === node.connId ? priorGeneration.generation : undefined;
    const retentionInput: NodeWorkerWorkspaceRetainInput = {
      ...baseInput,
      bundleHashes: retainedBundleHashes,
      ...(acknowledgedBundleGeneration !== undefined ? { acknowledgedBundleGeneration } : {}),
    };
    const bundleHashesFit =
      retainedBundleHashes.length <= NODE_WORKER_BUNDLE_RETAIN_MAX_HASHES &&
      Buffer.byteLength(JSON.stringify(retentionInput), "utf8") <=
        NODE_WORKER_RETAIN_REQUEST_MAX_BYTES;
    const bundleStatusTarget =
      node.workerHost.bundleStatus === NODE_WORKER_BUNDLE_STATUS_VERSION
        ? (hostBuild ?? bundleStatusTargetForNode(options, node.nodeId))
        : undefined;
    const previousBundleStatus = currentTransport.getBundleStatus?.(node.nodeId);
    // Bundles are content-addressed. Tampering while the node runs is detected by
    // the next node launch/install or explicit inspection, not every retention pass.
    const statusInput =
      bundleStatusTarget &&
      retainedBundleHashes.includes(bundleStatusTarget.bundleHash) &&
      (previousBundleStatus?.bundleHash !== bundleStatusTarget.bundleHash ||
        previousBundleStatus.status.status !== "installed")
        ? { ...retentionInput, bundleStatusHash: bundleStatusTarget.bundleHash }
        : undefined;
    const input =
      bundleRetentionSupported && bundlePreparationError === undefined && bundleHashesFit
        ? statusInput &&
          Buffer.byteLength(JSON.stringify(statusInput), "utf8") <=
            NODE_WORKER_RETAIN_REQUEST_MAX_BYTES
          ? statusInput
          : retentionInput
        : baseInput;
    if (
      !bundleStatusTarget ||
      !input.bundleHashes?.includes(bundleStatusTarget.bundleHash) ||
      (previousBundleStatus && previousBundleStatus.bundleHash !== bundleStatusTarget.bundleHash)
    ) {
      currentTransport.acceptBundleStatus?.(node, undefined);
    }
    if (bundlePreparationError !== undefined) {
      options.warn(`Node bundle retention skipped (${node.nodeId}): ${bundlePreparationError}`);
    } else if (bundleRetentionSupported && !bundleHashesFit) {
      options.warn(
        `Node bundle retention skipped (${node.nodeId}): ${retainedBundleHashes.length} retained hashes exceed the bounded maintenance request`,
      );
    }
    for (;;) {
      const isDispatchAuthorized = () => {
        try {
          return (
            isCurrent() &&
            isDeepStrictEqual(
              input.retain,
              snapshotEntriesForNode(
                options,
                node.nodeId,
                preparedManifestRefs,
                preparedPlacements,
              ),
            )
          );
        } catch {
          return false;
        }
      };
      if (!isDispatchAuthorized()) {
        return;
      }
      const result = await currentTransport.invoke({
        node,
        command: NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
        params: input,
        timeoutMs: RETAIN_COMMAND_TIMEOUT_MS,
        signal: abortController.signal,
        isDispatchAuthorized,
      });
      if (!isCurrent()) {
        return;
      }
      if (!result.ok) {
        throw new Error(
          result.error?.message ??
            `workspace retain command failed (${result.error?.code ?? "unknown"})`,
        );
      }
      const payload = parseNodeWorkerResponse(
        result.payloadJSON || "null",
        "workspace retain command",
      );
      const retained = parseNodeWorkerWorkspaceRetainResult(payload);
      if (!retained) {
        throw new Error("workspace retain command violated its private result contract");
      }
      if (retained.applied && retained.bundleGeneration !== undefined) {
        acknowledgedBundleGenerationByNode.set(node.nodeId, {
          connId: node.connId,
          generation: retained.bundleGeneration,
        });
      }
      if (!retained.applied || !retained.hasMore) {
        const bundleStatus = retained.bundleStatus;
        if (
          retained.applied &&
          bundleStatusTarget &&
          bundleStatus &&
          bundleStatus.bundleHash === input.bundleStatusHash
        ) {
          currentTransport.acceptBundleStatus?.(node, {
            bundleHash: bundleStatusTarget.bundleHash,
            status:
              bundleStatus.status === "installed"
                ? { status: "installed", version: bundleStatusTarget.openclawVersion }
                : { status: "missing" },
          });
        } else if (input.bundleStatusHash) {
          currentTransport.acceptBundleStatus?.(node, undefined);
        }
        return;
      }
    }
  };

  const publishSnapshot = async (
    currentTransport: NodeWorkerSupervisorTransport,
    node: NodeWorkerSupervisorNodeProof,
  ): Promise<void> => {
    const prepared = new Map<string, PreparedPlacement>();
    try {
      const sessionIds = new Set(
        nodeEnvironments(options, node.nodeId).flatMap((environment) =>
          !isTerminalWorkerEnvironmentState(environment.state) &&
          environment.attachedSessionIds.length === 1
            ? environment.attachedSessionIds
            : [],
        ),
      );
      for (const sessionId of sessionIds) {
        prepared.set(sessionId, await options.placements.prepareRuntimeRefresh(sessionId));
      }
      await publishPreparedSnapshot(currentTransport, node, prepared);
    } finally {
      for (const facts of prepared.values()) {
        facts.release();
      }
    }
  };

  const schedule = (nodeId?: string): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    const target = nodeId || undefined;
    pendingNodes.add(target);
    if (!started || !transport) {
      return Promise.resolve();
    }
    const previous = operations.get(nodeId);
    if (previous) {
      return previous;
    }
    const run = async () => {
      do {
        pendingNodes.delete(target);
        const currentTransport = transport;
        if (!currentTransport || stopped) {
          return;
        }
        try {
          const nodes = await currentTransport.listCurrentNodes();
          if (stopped || transport !== currentTransport) {
            continue;
          }
          if (nodeId) {
            const node = nodes.find((candidate) => candidate.nodeId === nodeId);
            if (node && currentTransport.isCurrent(node)) {
              await publishSnapshot(currentTransport, node);
            }
          } else {
            // The all-node join reports completion; each reconnect has its own
            // coalesced operation and never queues behind another node's maintenance.
            await Promise.all(nodes.map((node) => schedule(node.nodeId)));
          }
        } catch (error) {
          options.warn(
            `Node workspace retain publication failed (${nodeId ?? "inventory"}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } while (pendingNodes.has(target));
    };
    const operation = runOutsideAsyncWorkScope(run).finally(() => {
      operations.delete(nodeId);
      if (!stopped && pendingNodes.has(target)) {
        void schedule(nodeId);
      }
    });
    operations.set(nodeId, operation);
    return operation;
  };

  return {
    bindTransport(next: NodeWorkerSupervisorTransport): void {
      transport = next;
      if (started) {
        void schedule();
      }
    },
    start(): Promise<void> {
      started = true;
      const targets = pendingNodes.has(undefined) ? [undefined] : [...pendingNodes];
      pendingNodes.clear();
      return Promise.all((targets.length ? targets : [undefined]).map(schedule)).then(
        () => undefined,
      );
    },
    schedule,
    async stop(): Promise<void> {
      stopped = true;
      started = false;
      abortController.abort(new Error("node workspace retention stopped"));
      pendingNodes.clear();
      await Promise.all(operations.values());
    },
  };
}
