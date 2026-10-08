import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import {
  createNodeRunnerInventoryIssueError,
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION,
  resolveNodeWorkerLaunchToolNames,
} from "../../infra/node-runner-inventory.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import type { NodeWorkerLaunchInput } from "../../worker/node-supervisor-protocol.js";
import {
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../../worker/node-workspace-protocol.js";
import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../../worker/node-workspace-transfer-protocol.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import {
  measureNodeWorkerLaunchBytes,
  nodeWorkerSpawnResultFromReceipt,
  RETRYABLE_NODE_WORKER_TRANSPORT_CODES,
  type createNodeWorkerLaunchAdapter,
} from "./node-launch-adapter.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import { createNodeWorkerProcessObserver } from "./node-worker-process-observation.js";
import { parseNodeWorkerResponse } from "./node-worker-response.js";
import {
  createNodeWorkerWorkspaceActions,
  type NodeWorkerWorkspaceBinding,
} from "./node-worker-workspace-actions.js";
import { drainNodeWorkerWorkspace } from "./node-worker-workspace-drain.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import {
  joinWorkerTunnelStops,
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTunnelStopReason,
  type WorkerTunnelStatus,
  type WorkerTurnTunnelHandle,
  type WorkerWorkspaceCommand,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import { workerWorkspaceCommandSucceeded } from "./workspace-sync-helpers.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_RESULT_GRACE_MS = 5_000;
const RETRY_DELAY_MS = 100;
const WORKSPACE_DIAGNOSTIC_MAX_CHARS = 500;
const tunnelLog = createSubsystemLogger("gateway/worker-tunnel");

export type NodeWorkerWorkspaceBindingResolver = (binding: {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
}) => Promise<NodeWorkerWorkspaceBinding | undefined>;

type NodeWorkerTunnelManagerOptions = {
  gatewayDeviceId: string;
  getEnvironment: (environmentId: string) => WorkerEnvironmentRecord | undefined;
  listEnvironments: () => readonly WorkerEnvironmentRecord[];
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  launchNodeWorker: ReturnType<typeof createNodeWorkerLaunchAdapter>["launch"];
  validateWorkerTurn: (claim: WorkerSessionTurnClaim) => boolean;
  workspaceTransfer: NodeWorkspaceTransferService;
};

type NodeWorkerTunnelStartRequest = {
  executionMode: "worker-turn" | "remote-exec";
  environmentId: string;
  ownerEpoch: number;
  deviceId: string;
  sessionId: string;
  expectedBuild: WorkerAdmissionHandshake;
  authorize?: () => void;
};

type NodeEnvironmentOwner = Omit<NodeWorkerTunnelStartRequest, "expectedBuild" | "authorize"> & {
  stopPromise?: Promise<void>;
  stopReason?: WorkerTunnelStopReason;
  drainLocalWork?: () => Promise<void>;
};

type NodeTunnelEntry = NodeEnvironmentOwner & {
  expectedBuild: WorkerAdmissionHandshake;
  abortController: AbortController;
  handle?: WorkerTurnTunnelHandle;
  initialization?: Promise<void>;
  launchTasks: Set<Promise<unknown>>;
  workspaceTasks: Set<Promise<unknown>>;
  nativeWorkspaceLeases: Set<string>;
  readiness: Deferred<WorkerTurnTunnelHandle>;
};

/** Owns node-channel handles without treating the persistent machine as a disposable lease. */
export function createNodeWorkerTunnelManager(options: NodeWorkerTunnelManagerOptions) {
  const entries = new Map<string, NodeTunnelEntry>();
  const retiredEntries = new Set<NodeEnvironmentOwner>();
  let resolveWorkspaceBinding: NodeWorkerWorkspaceBindingResolver | undefined;
  const gatewayNamespace = nodeWorkerGatewayNamespace(options.gatewayDeviceId);

  const hasDurableBinding = (entry: NodeTunnelEntry): boolean => {
    const current = options.getEnvironment(entry.environmentId);
    return Boolean(
      current &&
      current.ownerEpoch === entry.ownerEpoch &&
      current.bootstrapReceipt?.installKind === "bundle" &&
      sameWorkerBuild(current.bootstrapReceipt, entry.expectedBuild) &&
      current.attachedSessionIds.length <= 1 &&
      (current.attachedSessionIds.length === 0 ||
        current.attachedSessionIds[0] === entry.sessionId),
    );
  };

  const isLiveEntry = (entry: NodeTunnelEntry): boolean =>
    entries.get(entry.environmentId) === entry && !entry.abortController.signal.aborted;

  const isEnvironmentOwner = (entry: NodeTunnelEntry): boolean =>
    hasDurableBinding(entry) && isLiveEntry(entry);

  const readPreparation = (entry: NodeTunnelEntry) =>
    readWorkerProjectPreparation(
      options.getEnvironment(entry.environmentId)?.profileSnapshot.project,
    );
  const findNode = async (
    entry: NodeEnvironmentOwner,
    signal: AbortSignal,
  ): Promise<{ transport: NodeWorkerSupervisorTransport; node: NodeWorkerSupervisorNodeProof }> => {
    const transport = options.getTransport();
    if (!transport) {
      throw new Error("device worker node transport is unavailable");
    }
    const node = await raceNodeWorkerOperation(transport.getCurrentNode(entry.deviceId), signal);
    if (!node) {
      throw new WorkerTunnelOwnerDisconnectedError(
        "device worker node is not connected with the supervisor dialect",
      );
    }
    return { transport, node };
  };

  const drainWorkspace = (entry: NodeEnvironmentOwner, isAuthorized: () => boolean) =>
    drainNodeWorkerWorkspace({
      ...entry,
      gatewayNamespace,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      findNode: (signal) => findNode(entry, signal),
      isAuthorized,
    });

  const invokeWorkspaceCommand = async (
    entry: NodeTunnelEntry,
    command: WorkerWorkspaceCommand & { resetWorkspace?: boolean; sessionKey?: string },
    onDispatchReady: () => void,
  ): Promise<NodeWorkerWorkspaceExecResult> => {
    const assertCurrent = () => {
      if (!isEnvironmentOwner(entry)) {
        throw new Error("node worker workspace authority closed");
      }
      command.assertCurrent?.();
    };
    const commandTimeoutMs = command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    // Keep the subprocess deadline authoritative while allowing its terminal result to cross the
    // node transport. Equal deadlines turn an ordinary process timeout into a transport failure.
    const transportTimeoutMs =
      addTimerTimeoutGraceMs(commandTimeoutMs, COMMAND_RESULT_GRACE_MS) ?? commandTimeoutMs;
    const deadline = Date.now() + transportTimeoutMs;
    const signals = [entry.abortController.signal, AbortSignal.timeout(transportTimeoutMs)];
    if (command.signal) {
      signals.push(command.signal);
    }
    const signal = AbortSignal.any(signals);
    const preparationKey = readPreparation(entry)?.key;
    let nativeContractError: Error | undefined;
    const input: NodeWorkerWorkspaceExecInput = {
      gatewayNamespace,
      environmentId: entry.environmentId,
      sessionId: entry.sessionId,
      ...(preparationKey === undefined ? {} : { preparationKey, sessionKey: command.sessionKey }),
      generation: entry.ownerEpoch,
      argv: [...command.argv],
      ...(command.input === undefined ? {} : { input: command.input }),
      timeoutMs: commandTimeoutMs,
      ...(command.resetWorkspace === undefined ? {} : { resetWorkspace: command.resetWorkspace }),
      ...(command.transfer === undefined ? {} : { transfer: command.transfer }),
      ...(command.seed === undefined ? {} : { seed: command.seed }),
      ...(command.process === undefined ? {} : { process: command.process }),
      ...(command.quiescence === undefined ? {} : { quiescence: command.quiescence }),
    };
    while (true) {
      assertCurrent();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || signal.aborted) {
        throw signal.reason ?? new Error("node worker workspace command timed out");
      }
      let result: Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>;
      try {
        const { node, transport } = await findNode(entry, signal);
        assertCurrent();
        const nativeOwnership =
          node.workerHost.workspaceQuiescence === NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION;
        const assertNativeContract = () => {
          if ((input.quiescence || entry.nativeWorkspaceLeases.size > 0) && !nativeOwnership) {
            nativeContractError ??= new Error(
              "node workspace quiescence support changed; reconnect a compatible node host",
            );
            throw nativeContractError;
          }
        };
        assertNativeContract();
        const params: NodeWorkerWorkspaceExecInput = {
          ...input,
          ...(nativeOwnership &&
          !command.legacyQuiescence &&
          !input.quiescence &&
          !input.process &&
          !input.transfer &&
          !input.seed
            ? { nativeProcessOwner: true }
            : {}),
        };
        result = await transport.invoke({
          node,
          command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
          params,
          timeoutMs: remainingMs,
          signal,
          onDispatchReady: () => {
            if (input.quiescence?.action === "acquire") {
              // An unacknowledged acquisition can still own a helper. Keep its contract
              // until this exact nonce is released, not merely until this request ends.
              entry.nativeWorkspaceLeases.add(input.quiescence.nonce);
            }
            onDispatchReady();
          },
          isDispatchAuthorized: () => {
            assertCurrent();
            assertNativeContract();
            return true;
          },
        });
      } catch (error) {
        assertCurrent();
        if (
          (nativeContractError !== undefined && error === nativeContractError) ||
          command.transportRetry !== "idempotent" ||
          signal.aborted ||
          !isEnvironmentOwner(entry)
        ) {
          throw error;
        }
        await sleepWithAbort(Math.min(RETRY_DELAY_MS, Math.max(1, deadline - Date.now())), signal);
        continue;
      }
      if (!result.ok) {
        const code = result.error?.code ?? "UNAVAILABLE";
        if (code === NODE_WORKSPACE_TRANSFER_ERROR_CODE) {
          throw new NodeWorkerWorkspaceTransferError(
            boundedWorkerError(
              result.error?.message ?? "workspace-transfer-failed: transfer did not complete",
              WORKSPACE_DIAGNOSTIC_MAX_CHARS,
            ),
          );
        }
        if (
          command.transportRetry === "idempotent" &&
          RETRYABLE_NODE_WORKER_TRANSPORT_CODES.has(code)
        ) {
          await sleepWithAbort(Math.min(RETRY_DELAY_MS, remainingMs), signal);
          continue;
        }
        throw new Error(
          result.error?.message
            ? `node workspace command failed (${code}): ${boundedWorkerError(result.error.message, WORKSPACE_DIAGNOSTIC_MAX_CHARS)}`
            : `node workspace command failed (${code})`,
        );
      }
      const parsed = parseNodeWorkerWorkspaceExecResult(
        parseNodeWorkerResponse(result.payloadJSON, "node workspace command"),
        command.argv,
      );
      if (!parsed) {
        throw new Error("node workspace command violated its private result contract");
      }
      if (input.quiescence?.action === "release" && workerWorkspaceCommandSucceeded(parsed)) {
        entry.nativeWorkspaceLeases.delete(input.quiescence.nonce);
      }
      return parsed;
    }
  };

  const runWorkspaceCommand = (
    entry: NodeTunnelEntry,
    command: WorkerWorkspaceCommand & { resetWorkspace?: boolean; sessionKey?: string },
  ): Promise<NodeWorkerWorkspaceExecResult> => {
    let dispatched = false;
    const operation = invokeWorkspaceCommand(entry, command, () => {
      dispatched = true;
    }).catch(async (error: unknown) => {
      if (dispatched && isEnvironmentOwner(entry)) {
        try {
          // Keep the caller's lifecycle lock until an unknown result has physically settled.
          await drainWorkspace(entry, () => isEnvironmentOwner(entry));
        } catch (drainError) {
          retireEntry(entry);
          throw drainError;
        }
      }
      throw error;
    });
    entry.workspaceTasks.add(operation);
    return operation.finally(() => entry.workspaceTasks.delete(operation));
  };

  const createHandle = (
    entry: NodeTunnelEntry,
    restoredWorkspace: NodeWorkerWorkspaceBinding | undefined,
  ): {
    handle: WorkerTurnTunnelHandle;
    validateRestoredWorkspace: (authorize?: () => void) => Promise<void>;
  } => {
    const buildLaunchInput = (
      plan: NodeWorkerLaunchInput["descriptor"],
      claim: WorkerSessionTurnClaim,
    ): NodeWorkerLaunchInput => ({
      environmentSession: 1,
      launchId: plan.assignment.turnId,
      gatewayNamespace,
      expectedBundleHash: entry.expectedBuild.bundleHash,
      placementGeneration: claim.placementGeneration,
      ...(readPreparation(entry) ? { sessionKey: getSessionKey() } : {}),
      descriptor: plan,
    });
    const { validateRestoredWorkspace, getSessionKey, ...workspaceActions } =
      createNodeWorkerWorkspaceActions({
        environmentId: entry.environmentId,
        ownerEpoch: entry.ownerEpoch,
        sessionId: entry.sessionId,
        ownerSignal: entry.abortController.signal,
        isOwnerCurrent: () => isLiveEntry(entry),
        restoredWorkspace,
        supportsNativeQuiescence: async () => {
          const { node } = await findNode(entry, entry.abortController.signal);
          if (!isLiveEntry(entry)) {
            throw new Error("node worker workspace authority closed");
          }
          return node.workerHost.workspaceQuiescence === NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION;
        },
        workspaceTransfer: options.workspaceTransfer,
        runWorkspaceCommand: (command) => runWorkspaceCommand(entry, command),
      });
    const handle: WorkerTurnTunnelHandle = {
      ...workspaceActions,
      environmentId: entry.environmentId,
      ownerEpoch: entry.ownerEpoch,
      measureLaunchTurn: (plan, claim) =>
        measureNodeWorkerLaunchBytes(entry.deviceId, buildLaunchInput(plan, claim)),
      readLaunchToolNames: async () => {
        const node = await options.getTransport()?.getCurrentNode(entry.deviceId);
        return resolveNodeWorkerLaunchToolNames(node?.workerHost);
      },
      launchTurn: async (request) => {
        if (entry.executionMode !== "worker-turn") {
          throw new Error("remote-exec environments do not launch embedded worker turns");
        }
        const plan = request.plan;
        const claim = request.turnClaim;
        const isDispatchAuthorized = () =>
          isEnvironmentOwner(entry) &&
          claim.owner.kind === "worker" &&
          claim.owner.environmentId === entry.environmentId &&
          claim.owner.ownerEpoch === entry.ownerEpoch &&
          claim.sessionId === plan.admission.sessionId &&
          claim.runId === plan.assignment.runId &&
          options.validateWorkerTurn(claim);
        const operation = options.launchNodeWorker({
          deviceId: entry.deviceId,
          input: buildLaunchInput(plan, claim),
          isDispatchAuthorized,
          isCancellationAuthorized: () => hasDurableBinding(entry),
          timeoutMs: request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          ...(request.credentialExpiresAtMs === undefined
            ? {}
            : { credentialExpiresAtMs: request.credentialExpiresAtMs }),
          onDispatchReady: request.onDispatchReady,
          signal: request.signal
            ? AbortSignal.any([entry.abortController.signal, request.signal])
            : entry.abortController.signal,
        });
        entry.launchTasks.add(operation);
        try {
          return nodeWorkerSpawnResultFromReceipt(await operation);
        } finally {
          entry.launchTasks.delete(operation);
        }
      },
      stop: async () => {
        await stopEntry(entry);
      },
    };
    return { handle, validateRestoredWorkspace };
  };

  function retireEntry(entry: NodeTunnelEntry): void {
    if (entries.get(entry.environmentId) === entry) {
      entries.delete(entry.environmentId);
    }
    entry.abortController.abort(new Error("node worker tunnel owner stopped"));
    entry.readiness.reject(new Error("node worker tunnel stopped before connecting"));
    retiredEntries.add(entry);
  }

  function stopEntry(entry: NodeTunnelEntry, reason?: WorkerTunnelStopReason): Promise<void> {
    retireEntry(entry);
    return stopEnvironmentOwner(entry, reason);
  }

  function stopEnvironmentOwner(
    entry: NodeEnvironmentOwner,
    reason?: WorkerTunnelStopReason,
  ): Promise<void> {
    if (entry.stopPromise) {
      if (entry.stopReason === reason || !retiredEntries.has(entry)) {
        return entry.stopPromise;
      }
      // Shutdown and provider reconciliation can overlap. Drain the earlier operation,
      // then apply the stronger proof without treating local fencing as physical cleanup.
      return entry.stopPromise
        .catch((error: unknown) => {
          if (!reason) {
            throw error;
          }
        })
        .then(() => (retiredEntries.has(entry) ? stopEnvironmentOwner(entry, reason) : undefined));
    }
    retiredEntries.add(entry);
    entry.stopReason = reason;
    entry.stopPromise = (async () => {
      await entry.drainLocalWork?.();
      let stopping = true;
      try {
        if (reason !== "provider-destroying" && reason !== "provider-destroyed") {
          await drainWorkspace(entry, () => stopping && retiredEntries.has(entry));
        }
        // Remote-exec runtimes own their processes separately; this is only the embedded
        // worker's environment lifetime, not a new requirement on the workspace transport.
        if (entry.executionMode === "worker-turn" && reason === undefined) {
          const signal = AbortSignal.timeout(DEFAULT_COMMAND_TIMEOUT_MS);
          const { transport, node } = await findNode(entry, signal);
          if (node.workerHost.environmentSession !== NODE_WORKER_ENVIRONMENT_SESSION_VERSION) {
            throw createNodeRunnerInventoryIssueError(
              node.nodeId,
              NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
            );
          }
          // Retirement retains only authority to stop this exact old scope, including after
          // replacement. The node must match the tuple before touching any physical worker.
          const operation = transport.invoke({
            node,
            command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
            params: {
              gatewayNamespace,
              environmentId: entry.environmentId,
              sessionId: entry.sessionId,
              ownerEpoch: entry.ownerEpoch,
            },
            timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
            signal,
            isDispatchAuthorized: () => stopping && retiredEntries.has(entry),
          });
          const result = await raceNodeWorkerOperation(operation, signal);
          if (!result.ok) {
            const code = result.error?.code ?? "UNAVAILABLE";
            const message = `node worker environment stop failed (${code})`;
            throw RETRYABLE_NODE_WORKER_TRANSPORT_CODES.has(code)
              ? new WorkerTunnelOwnerDisconnectedError(message)
              : new Error(message);
          }
        }
      } finally {
        stopping = false;
        await options.workspaceTransfer.close(entry.environmentId);
      }
      if (reason !== "provider-destroying") {
        retiredEntries.delete(entry);
      }
    })().finally(() => {
      // Failed or unconfirmed provider teardown keeps the exact owner retryable. Only
      // physical-stop proof may release it and make subsequent stops idempotent.
      if (retiredEntries.has(entry)) {
        entry.stopPromise = undefined;
      }
    });
    return entry.stopPromise;
  }

  async function stop(
    environmentId: string,
    ownerEpoch?: number,
    reason?: WorkerTunnelStopReason,
  ): Promise<void> {
    const matches = (entry: NodeEnvironmentOwner) =>
      entry.environmentId === environmentId &&
      (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch);
    const live = [...entries.values()].filter(matches);
    const retired = [...retiredEntries].filter(matches);
    const operations = [
      ...live.map((entry) => stopEntry(entry, reason)),
      ...retired.map((entry) => stopEnvironmentOwner(entry, reason)),
    ];
    if (operations.length === 0) {
      // A restarted Gateway has no tunnel object. The durable attachment is the only
      // source of the retired scope; bundle metadata is not cleanup authority.
      const record = options.getEnvironment(environmentId);
      if (record?.nodeDeviceId && (ownerEpoch === undefined || record.ownerEpoch === ownerEpoch)) {
        if (reason === "provider-destroying" || reason === "provider-destroyed") {
          // Provider teardown owns the whole dedicated machine. No remote session tuple is
          // needed for local transfer cleanup; durable ownership remains until its proof.
          operations.push(options.workspaceTransfer.close(environmentId));
        } else {
          if (record.attachedSessionIds.length > 1) {
            throw new Error("node worker environment teardown has an ambiguous session owner");
          }
          const sessionId = record.attachedSessionIds[0];
          if (sessionId) {
            operations.push(
              stopEnvironmentOwner(
                {
                  deviceId: record.nodeDeviceId,
                  environmentId,
                  ownerEpoch: record.ownerEpoch,
                  sessionId,
                  executionMode:
                    record.profileSnapshot.executionMode === "remote-exec"
                      ? "remote-exec"
                      : "worker-turn",
                },
                reason,
              ),
            );
          }
        }
      }
    }
    await joinWorkerTunnelStops(operations);
  }

  return {
    observeProcesses: createNodeWorkerProcessObserver({ ...options, gatewayNamespace }),
    async runSessionCommand(
      binding: { environmentId: string; ownerEpoch: number; sessionId: string; sessionKey: string },
      command: WorkerWorkspaceCommand,
    ): Promise<NodeWorkerWorkspaceExecResult> {
      const authorize = () => {
        command.signal?.throwIfAborted();
        command.assertCurrent?.();
      };
      authorize();
      const record = options.getEnvironment(binding.environmentId);
      if (
        !record ||
        record.ownerEpoch !== binding.ownerEpoch ||
        !record.nodeDeviceId ||
        record.sharedHost !== false ||
        !record.bootstrapReceipt ||
        record.bootstrapReceipt.installKind !== "bundle"
      ) {
        throw new Error("Attached environment node workspace is unavailable");
      }
      await this.start({
        environmentId: binding.environmentId,
        ownerEpoch: binding.ownerEpoch,
        sessionId: binding.sessionId,
        deviceId: record.nodeDeviceId,
        // The node workspace owns attached apps independently of this Gateway connection.
        // Closing its transport must not retire the still-live attachment's process scope.
        executionMode: "remote-exec",
        expectedBuild: record.bootstrapReceipt,
        authorize,
      });
      authorize();
      const entry = entries.get(binding.environmentId);
      if (
        !entry ||
        entry.ownerEpoch !== binding.ownerEpoch ||
        entry.sessionId !== binding.sessionId
      ) {
        throw new Error("Attached environment execution owner changed");
      }
      return await runWorkspaceCommand(entry, { ...command, sessionKey: binding.sessionKey });
    },
    bindWorkspaceBindingResolver(resolver: NodeWorkerWorkspaceBindingResolver): void {
      resolveWorkspaceBinding = resolver;
    },
    async start(request: NodeWorkerTunnelStartRequest): Promise<WorkerTurnTunnelHandle> {
      request.authorize?.();
      const current = entries.get(request.environmentId);
      const retiring = [...retiredEntries].filter(
        (entry) => entry.environmentId === request.environmentId,
      );
      if ([current, ...retiring].some((owner) => owner && owner.ownerEpoch > request.ownerEpoch)) {
        throw new Error("node worker tunnel owner epoch is stale");
      }
      if (current?.ownerEpoch === request.ownerEpoch) {
        if (
          current.abortController.signal.aborted ||
          current.executionMode !== request.executionMode ||
          current.deviceId !== request.deviceId ||
          current.sessionId !== request.sessionId ||
          !sameWorkerBuild(current.expectedBuild, request.expectedBuild)
        ) {
          throw new Error("node worker tunnel owner binding changed within one epoch");
        }
        const handle = await current.readiness.promise;
        // Recheck the joining caller without stopping the independently owned tunnel.
        request.authorize?.();
        return handle;
      }
      const readiness = createDeferredCore<WorkerTurnTunnelHandle>();
      void readiness.promise.catch(() => undefined);
      const entry: NodeTunnelEntry = {
        executionMode: request.executionMode,
        environmentId: request.environmentId,
        ownerEpoch: request.ownerEpoch,
        deviceId: request.deviceId,
        sessionId: request.sessionId,
        expectedBuild: request.expectedBuild,
        abortController: new AbortController(),
        launchTasks: new Set(),
        workspaceTasks: new Set(),
        nativeWorkspaceLeases: new Set(),
        readiness,
      };
      entry.drainLocalWork = async () => {
        await entry.initialization?.catch(() => undefined);
        await Promise.allSettled(entry.launchTasks);
        await Promise.allSettled(entry.workspaceTasks);
      };
      // Publish the new epoch before any teardown or initialization await so stop and replacement
      // can fence it, while exact same-owner callers share this readiness barrier.
      entries.set(entry.environmentId, entry);
      entry.initialization = (async () => {
        if (current) {
          await stopEntry(current);
        }
        await Promise.all(retiring.map((owner) => stopEnvironmentOwner(owner)));
        request.authorize?.();
        if (!isLiveEntry(entry)) {
          return;
        }
        const restoredWorkspace = resolveWorkspaceBinding
          ? await raceNodeWorkerOperation(
              resolveWorkspaceBinding({
                environmentId: request.environmentId,
                ownerEpoch: request.ownerEpoch,
                sessionId: request.sessionId,
              }),
              entry.abortController.signal,
            )
          : undefined;
        request.authorize?.();
        if (!isLiveEntry(entry)) {
          return;
        }
        const created = createHandle(entry, restoredWorkspace);
        if (restoredWorkspace) {
          await drainWorkspace(entry, () => isEnvironmentOwner(entry));
        }
        await created.validateRestoredWorkspace(request.authorize);
        request.authorize?.();
        if (!isLiveEntry(entry)) {
          return;
        }
        entry.handle = created.handle;
        readiness.resolve(created.handle);
      })();
      void entry.initialization.catch((error: unknown) => {
        readiness.reject(error);
        // Startup already reports the owning error through readiness. Keep secondary cleanup
        // failures visible without replacing that shared result for concurrent callers.
        void stopEntry(entry).catch((cleanupError: unknown) => {
          tunnelLog.warn("node worker tunnel cleanup failed after initialization error", {
            environmentId: entry.environmentId,
            ownerEpoch: entry.ownerEpoch,
            error: boundedWorkerError(cleanupError),
          });
        });
      });
      return await readiness.promise;
    },
    stop,
    async stopAll(): Promise<void> {
      const live = new Set([
        ...entries.keys(),
        ...[...retiredEntries].map((entry) => entry.environmentId),
      ]);
      const stopped = await Promise.allSettled([
        ...[...live].map((environmentId) => stop(environmentId)),
        // A revoked inventory reports its failure without stranding live tunnels.
        (async () =>
          joinWorkerTunnelStops(
            options
              .listEnvironments()
              .filter((record) => record.nodeDeviceId && !live.has(record.environmentId))
              .map((record) => stop(record.environmentId)),
          ))(),
      ]);
      // Shared transfer state outlives every tunnel, even when a sibling's cleanup fails.
      stopped.push(...(await Promise.allSettled([options.workspaceTransfer.closeAll()])));
      const failure = stopped.find((result) => result.status === "rejected");
      if (failure) {
        throw failure.reason;
      }
    },
    status(environmentId: string): WorkerTunnelStatus {
      const entry = entries.get(environmentId);
      return entry && !entry.abortController.signal.aborted
        ? entry.handle
          ? "connected"
          : "connecting"
        : "stopped";
    },
  };
}

export type NodeWorkerTunnelManager = ReturnType<typeof createNodeWorkerTunnelManager>;
