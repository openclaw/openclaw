import { createHash, randomUUID } from "node:crypto";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { computeBackoff, sleepWithAbort } from "../../infra/backoff.js";
import {
  NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
} from "../../infra/node-commands.js";
import {
  createNodeRunnerInventoryIssueError,
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_STATUS_WAIT_VERSION,
  resolveNodeWorkerExecutionIssue,
} from "../../infra/node-runner-inventory.js";
import type { SpawnResult } from "../../process/exec.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import {
  nodeWorkerPlanHash,
  NODE_WORKER_STATUS_WAIT_MAX_MS,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerSupervisorReceipt,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
  type NodeWorkerSupervisorReceipt,
  nodeWorkerTurnMatchesIdentity,
} from "../../worker/node-supervisor-protocol.js";
import {
  parseWorkerAdmissionDeadlineResult,
  WORKER_ADMISSION_DEADLINE_MS,
} from "../../worker/worker-connection-contract.js";
import { measureWorkerProcessTurnBytes } from "../../worker/worker-process-protocol.js";
import { buildNodeInvokeRequest, serializeNodeEvent } from "../node-invoke-request.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { WorkerRunnerCapacityError, WorkerRunnerUnavailableError } from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";

export function nodeWorkerSpawnResultFromReceipt(
  receipt: TerminalNodeWorkerSupervisorReceipt,
): SpawnResult {
  return {
    stdout: receipt.state === "completed" ? receipt.resultJson : "",
    stderr: receipt.state === "completed" ? "" : receipt.errorText,
    code: receipt.state === "completed" ? 0 : 1,
    signal: null,
    killed: receipt.state === "cancelled" || receipt.state === "interrupted",
    termination: "exit",
  };
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;
const DEFAULT_CANCELLATION_TIMEOUT_MS = 30_000;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 10_000;
// Five 120s admission windows cover about ten minutes, still capped by the caller.
// Use the node host's exponential reconnect cadence plus worker reconnect jitter.
const MAX_ADMISSION_ATTEMPTS = 5;
const ADMISSION_REARM_BACKOFF = { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.1 };

export const RETRYABLE_NODE_WORKER_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "DISCONNECTED",
  "NOT_CONNECTED",
  "PAIRING_CHANGED",
  "PRIVATE_DIALECT_UNAVAILABLE",
  "ROUTE_CHANGED",
  "TIMEOUT",
  "UNAVAILABLE",
]);

type TerminalNodeWorkerSupervisorReceipt = Extract<
  NodeWorkerSupervisorReceipt,
  { state: "completed" | "failed" | "interrupted" | "cancelled" }
>;

type DeviceWorkerLaunchRequest = {
  deviceId: string;
  input: NodeWorkerLaunchInput;
  isDispatchAuthorized: () => boolean;
  isCancellationAuthorized: () => boolean;
  timeoutMs: number;
  credentialExpiresAtMs?: number;
  signal?: AbortSignal;
  onDispatchReady?: () => void;
};

type NodeWorkerLaunchAdapterOptions = {
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rpcTimeoutMs?: number;
  pollIntervalMs?: number;
  cancellationTimeoutMs?: number;
};

type OperationDeadline = {
  signal: AbortSignal;
  remainingMs: () => number;
  dispose: () => void;
};

class NodeWorkerLaunchTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isTerminalReceipt(
  receipt: NodeWorkerSupervisorReceipt,
): receipt is TerminalNodeWorkerSupervisorReceipt {
  return receipt.state !== "pending" && receipt.state !== "running";
}

function snapshotLaunchInput(input: NodeWorkerLaunchInput): NodeWorkerLaunchInput {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new Error("node worker launch input is not serializable");
  }
  return parseNodeWorkerLaunchInput(encoded);
}

function rearmNodeWorkerLaunchInput(
  input: NodeWorkerLaunchInput,
  attempt: number,
): NodeWorkerLaunchInput {
  const launchId = createHash("sha256")
    .update(`${input.launchId}:admission-rearm:${attempt}`)
    .digest("hex");
  return {
    ...input,
    launchId,
    descriptor: {
      ...input.descriptor,
      assignment: { ...input.descriptor.assignment, turnId: launchId },
    },
  };
}

export function measureNodeWorkerLaunchBytes(nodeId: string, input: NodeWorkerLaunchInput): number {
  const measured = input.descriptor.admission.handshake.protocolFeatures.includes(
    NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
  )
    ? { ...input, idleRetention: true as const }
    : input;
  // Re-arms replace a UUID with a SHA-256 hex turn ID. Measure both without changing
  // the original plan; the registry bounds timeouts and always generates UUID request IDs.
  return Math.max(
    ...[measured, rearmNodeWorkerLaunchInput(measured, 1)].flatMap((attempt) => [
      Buffer.byteLength(
        serializeNodeEvent(
          "node.invoke.request",
          buildNodeInvokeRequest({
            id: randomUUID(),
            nodeId,
            command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
            params: attempt,
            timeoutMs: MAX_TIMER_TIMEOUT_MS,
            idempotencyKey: attempt.launchId,
          }),
        ),
        "utf8",
      ),
      measureWorkerProcessTurnBytes(attempt.descriptor, attempt.idleRetention),
    ]),
  );
}

function expectedIdentity(input: NodeWorkerLaunchInput): NodeWorkerSupervisorIdentity {
  return {
    launchId: input.launchId,
    planHash: nodeWorkerPlanHash(input),
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    ownerEpoch: input.descriptor.admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    runId: input.descriptor.assignment.runId,
  };
}

function validateReceipt(
  receipt: NodeWorkerSupervisorReceipt,
  expected: NodeWorkerSupervisorIdentity,
): NodeWorkerSupervisorReceipt {
  if (!nodeWorkerTurnMatchesIdentity(receipt, expected)) {
    throw new Error("node worker supervisor receipt identity mismatch");
  }
  return receipt;
}

function parseInvokeReceipt(
  payloadJSON: string | null | undefined,
): NodeWorkerSupervisorReceipt | null {
  if (!payloadJSON) {
    throw new Error("node worker supervisor response omitted payload JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(payloadJSON) as unknown;
  } catch {
    throw new Error("node worker supervisor response contained malformed JSON");
  }
  if (value === null) {
    return null;
  }
  const receipt = parseNodeWorkerSupervisorReceipt(value);
  if (!receipt) {
    throw new Error("node worker supervisor response violated the private receipt contract");
  }
  return receipt;
}

function signalError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function createDeadline(params: {
  now: () => number;
  timeoutMs: number;
  signal?: AbortSignal;
  parent?: OperationDeadline;
  label: string;
}): OperationDeadline {
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    throw new Error(`${params.label} timeout must be a positive finite number`);
  }
  const controller = new AbortController();
  const expiresAtMs = params.now() + params.timeoutMs;
  const expire = () => {
    params.parent?.remainingMs();
    controller.abort(new Error(`${params.label} timed out`));
  };
  const timer = setTimeout(expire, params.timeoutMs);
  timer.unref?.();
  const parentSignal = params.parent?.signal ?? params.signal;
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  return {
    signal,
    remainingMs: () => {
      // Clock reads can observe expiry before timers run. Publish the same abort,
      // synchronizing the parent first so a launch timeout retains precedence.
      params.parent?.remainingMs();
      const remainingMs = Math.max(0, expiresAtMs - params.now());
      if (remainingMs === 0) {
        expire();
      }
      return remainingMs;
    },
    dispose: () => clearTimeout(timer),
  };
}

export function createNodeWorkerLaunchAdapter(options: NodeWorkerLaunchAdapterOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepWithAbort;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cancellationTimeoutMs = options.cancellationTimeoutMs ?? DEFAULT_CANCELLATION_TIMEOUT_MS;

  const findNode = async (params: {
    transport: NodeWorkerSupervisorTransport;
    deviceId: string;
    signal: AbortSignal;
  }): Promise<NodeWorkerSupervisorNodeProof> => {
    let node: NodeWorkerSupervisorNodeProof | undefined;
    try {
      node = await raceNodeWorkerOperation(
        params.transport.getCurrentNode(params.deviceId),
        params.signal,
      );
    } catch (error) {
      if (params.signal.aborted) {
        throw error;
      }
      throw new NodeWorkerLaunchTransportError(
        "UNAVAILABLE",
        "device worker node discovery is unavailable",
      );
    }
    if (!node) {
      throw new NodeWorkerLaunchTransportError(
        "NOT_CONNECTED",
        "device worker node is not currently connected",
      );
    }
    return node;
  };

  const invoke = async (params: {
    deviceId: string;
    command:
      | typeof NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND
      | typeof NODE_WORKER_SUPERVISOR_STATUS_COMMAND
      | typeof NODE_WORKER_SUPERVISOR_CANCEL_COMMAND;
    payload: NodeWorkerLaunchInput | NodeWorkerSupervisorIdentity | { launchId: string };
    isAuthorized: () => boolean;
    deadline: OperationDeadline;
    onDispatchReady?: () => void;
    idleRetention?: true;
    prepareLaunch?: (node: NodeWorkerSupervisorNodeProof) => void;
  }): Promise<{ receipt: NodeWorkerSupervisorReceipt | null; statusWait: boolean }> => {
    if (!params.isAuthorized()) {
      throw new NodeWorkerLaunchTransportError(
        "APPROVAL_AUTHORITY_CLOSED",
        "node worker authority closed",
      );
    }
    const remainingMs = params.deadline.remainingMs();
    params.deadline.signal.throwIfAborted();
    const transport = options.getTransport();
    if (!transport) {
      throw new NodeWorkerLaunchTransportError(
        "UNAVAILABLE",
        "device worker node transport is unavailable",
      );
    }
    // The deadline is the sole expiry authority unless the per-RPC budget binds first.
    // A second timer armed at the same expiry makes "retryable RPC timeout" versus
    // "terminal deadline" a scheduling race, and the retryable branch then funds another
    // attempt out of a residual budget too small to complete it.
    const rpcBudgetMs = Math.min(rpcTimeoutMs, remainingMs);
    const rpcController = rpcBudgetMs < remainingMs ? new AbortController() : undefined;
    const rpcTimer = rpcController
      ? setTimeout(() => rpcController.abort(new Error("node worker RPC timed out")), rpcBudgetMs)
      : undefined;
    rpcTimer?.unref?.();
    const signal = rpcController
      ? AbortSignal.any([params.deadline.signal, rpcController.signal])
      : params.deadline.signal;
    try {
      const node = await findNode({
        transport,
        deviceId: params.deviceId,
        signal,
      });
      params.prepareLaunch?.(node);
      if (!params.prepareLaunch && params.idleRetention && node.workerHost.idleRetention !== true) {
        throw new NodeWorkerLaunchTransportError(
          "PRIVATE_DIALECT_UNAVAILABLE",
          "node worker idle retention is unavailable",
        );
      }
      if (
        params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND &&
        (node.workerHost.environmentSession !== NODE_WORKER_ENVIRONMENT_SESSION_VERSION ||
          resolveNodeWorkerExecutionIssue(node.workerHost))
      ) {
        throw createNodeRunnerInventoryIssueError(node.nodeId, NODE_RUNNER_UPDATE_REQUIRED_ISSUE);
      }
      // A retained environment already owns its slot. The node arbitrates new physical
      // launches atomically; its advertised free-slot count cannot reject turn reuse.
      const statusWait = node.workerHost.statusWait === NODE_WORKER_STATUS_WAIT_VERSION;
      const operation = transport.invoke({
        node,
        command: params.command,
        params:
          params.command === NODE_WORKER_SUPERVISOR_STATUS_COMMAND && statusWait
            ? {
                ...params.payload,
                // Leave time for receipt delivery and transport authority revalidation.
                waitMs: Math.min(
                  NODE_WORKER_STATUS_WAIT_MAX_MS,
                  Math.max(1, Math.floor(rpcBudgetMs * 0.75)),
                ),
              }
            : params.payload,
        timeoutMs: rpcBudgetMs,
        signal,
        idempotencyKey:
          params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND
            ? params.payload.launchId
            : undefined,
        isDispatchAuthorized: params.isAuthorized,
        ...(params.onDispatchReady ? { onDispatchReady: params.onDispatchReady } : {}),
      });
      const result = await raceNodeWorkerOperation(operation, signal);
      if (!result.ok) {
        const code = result.error?.code ?? "UNAVAILABLE";
        if (code === NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE) {
          throw new WorkerRunnerCapacityError();
        }
        const detail = result.error?.message?.trim();
        throw new NodeWorkerLaunchTransportError(
          code,
          boundedWorkerError(
            `node worker supervisor ${params.command} failed (${code})${detail ? `: ${detail}` : ""}`,
          ),
        );
      }
      return { receipt: parseInvokeReceipt(result.payloadJSON), statusWait };
    } catch (error) {
      if (rpcController?.signal.aborted && !params.deadline.signal.aborted) {
        throw new NodeWorkerLaunchTransportError("TIMEOUT", "node worker RPC timed out");
      }
      throw error;
    } finally {
      clearTimeout(rpcTimer);
    }
  };

  const waitBeforeRetry = async (params: {
    delayMs: number;
    deadline: OperationDeadline;
  }): Promise<number> => {
    const remainingMs = params.deadline.remainingMs();
    params.deadline.signal.throwIfAborted();
    await raceNodeWorkerOperation(
      sleep(Math.min(params.delayMs, remainingMs), params.deadline.signal),
      params.deadline.signal,
    );
    return Math.min(params.delayMs * 2, MAX_RETRY_DELAY_MS);
  };

  const cancelUntilTerminal = async (params: {
    request: DeviceWorkerLaunchRequest;
    expected: NodeWorkerSupervisorIdentity;
  }): Promise<TerminalNodeWorkerSupervisorReceipt> => {
    const deadline = createDeadline({
      now,
      timeoutMs: cancellationTimeoutMs,
      label: "node worker cancellation",
    });
    let delayMs = pollIntervalMs;
    try {
      while (!deadline.signal.aborted && deadline.remainingMs() > 0) {
        if (!params.request.isCancellationAuthorized()) {
          throw new Error("node worker cancellation authority closed before terminal settlement");
        }
        try {
          const { receipt } = await invoke({
            deviceId: params.request.deviceId,
            command: NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
            payload: params.expected,
            isAuthorized: params.request.isCancellationAuthorized,
            deadline,
          });
          if (receipt) {
            const validated = validateReceipt(receipt, params.expected);
            if (isTerminalReceipt(validated)) {
              return validated;
            }
            delayMs = pollIntervalMs;
          }
        } catch (error) {
          if (deadline.signal.aborted) {
            break;
          }
          if (
            !(error instanceof NodeWorkerLaunchTransportError) ||
            !RETRYABLE_NODE_WORKER_TRANSPORT_CODES.has(error.code)
          ) {
            throw error;
          }
        }
        delayMs = await waitBeforeRetry({ delayMs, deadline });
      }
    } finally {
      deadline.dispose();
    }
    throw new Error(
      "node worker cancellation did not produce a terminal receipt before its deadline",
    );
  };

  const launch = async (
    request: DeviceWorkerLaunchRequest,
  ): Promise<TerminalNodeWorkerSupervisorReceipt> => {
    const restartSignal = getGatewayRestartDrainSignal();
    const originalInput = snapshotLaunchInput(request.input);
    let input = originalInput;
    const stableRequest = { ...request, input };
    let expected = expectedIdentity(input);
    let admissionAttempts = 1;
    const deadline = createDeadline({
      now,
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
      label: "node worker launch",
    });
    const availabilityDeadline = createDeadline({
      now,
      timeoutMs: DEFAULT_AVAILABILITY_TIMEOUT_MS,
      parent: deadline,
      label: "node worker availability",
    });
    // Discovery and handoff use the availability grace; dispatched RPCs keep the caller budget.
    const dispatchDeadline: OperationDeadline = {
      ...deadline,
      signal: availabilityDeadline.signal,
    };
    let mayHaveLaunched = false;
    let dispatchReady = false;
    let pollStatus = false;
    let delayMs = pollIntervalMs;
    const markDispatchReady = () => {
      mayHaveLaunched = true;
      if (!dispatchReady) {
        dispatchReady = true;
        availabilityDeadline.dispose();
        stableRequest.onDispatchReady?.();
      }
    };
    try {
      while (true) {
        if (deadline.signal.aborted) {
          throw signalError(deadline.signal, "node worker launch aborted");
        }
        if (!stableRequest.isDispatchAuthorized()) {
          throw new Error("node worker launch authority closed");
        }
        const launchMayAlreadyExist = mayHaveLaunched;
        try {
          const { receipt, statusWait } = await invoke({
            deviceId: stableRequest.deviceId,
            command: pollStatus
              ? NODE_WORKER_SUPERVISOR_STATUS_COMMAND
              : NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
            payload: pollStatus ? { launchId: input.launchId } : input,
            ...(!pollStatus && input.idleRetention ? { idleRetention: true as const } : {}),
            ...(!pollStatus && !mayHaveLaunched
              ? {
                  prepareLaunch: (node: NodeWorkerSupervisorNodeProof) => {
                    if (
                      node.workerHost.idleRetention === true &&
                      input.descriptor.admission.handshake.protocolFeatures.includes(
                        NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
                      )
                    ) {
                      input.idleRetention = true;
                    } else {
                      delete input.idleRetention;
                    }
                    expected = expectedIdentity(input);
                  },
                }
              : {}),
            isAuthorized: () => {
              if (!dispatchReady) {
                // Publish expiry through the signal; a guard throw can orphan the invoke promise.
                availabilityDeadline.remainingMs();
              }
              return stableRequest.isDispatchAuthorized();
            },
            deadline: dispatchDeadline,
            ...(!pollStatus
              ? {
                  onDispatchReady: markDispatchReady,
                }
              : {}),
          });
          if (!receipt) {
            pollStatus = false;
          } else {
            if (!pollStatus) {
              markDispatchReady();
            }
            const validated = validateReceipt(receipt, expected);
            mayHaveLaunched = true;
            if (isTerminalReceipt(validated)) {
              const admissionFailure =
                validated.state === "completed"
                  ? parseWorkerAdmissionDeadlineResult(JSON.parse(validated.resultJson))
                  : undefined;
              const rearmDelayMs = computeBackoff(ADMISSION_REARM_BACKOFF, admissionAttempts);
              // Re-arm only while the retried child still gets a full admission
              // window on the originally minted credential; a later start is
              // guaranteed to be rejected as credential-expired.
              const rearmAdmitsWithinCredential =
                stableRequest.credentialExpiresAtMs === undefined ||
                now() + rearmDelayMs + WORKER_ADMISSION_DEADLINE_MS <=
                  stableRequest.credentialExpiresAtMs;
              if (
                admissionFailure &&
                admissionAttempts < MAX_ADMISSION_ATTEMPTS &&
                rearmAdmitsWithinCredential
              ) {
                // The node journal holds this attempt's reason and proves its child
                // is gone. Re-arm only after backoff and current authority revalidation.
                mayHaveLaunched = false;
                await waitBeforeRetry({
                  delayMs: rearmDelayMs,
                  deadline,
                });
                // Deterministic IDs make a replay of this adapter find the same journal
                // rows, never another child for an already completed retry.
                input = rearmNodeWorkerLaunchInput(originalInput, admissionAttempts++);
                expected = expectedIdentity(input);
                pollStatus = false;
                delayMs = pollIntervalMs;
                continue;
              }
              return validated;
            }
            pollStatus = true;
            delayMs = pollIntervalMs;
            // Older node hosts retain timed polling; negotiated waits wake on durable settlement.
            if (statusWait) {
              continue;
            }
          }
        } catch (error) {
          // Supervisors answer INVALID_REQUEST before retaining any admission, turn, or child
          // for a launch ID they have not seen. Launch IDs are minted per turn plan, so only an
          // earlier dispatch in this call could have registered it; cancelling would otherwise
          // poll a null receipt until its deadline.
          if (
            !pollStatus &&
            !launchMayAlreadyExist &&
            error instanceof NodeWorkerLaunchTransportError &&
            error.code === "INVALID_REQUEST"
          ) {
            mayHaveLaunched = false;
            throw error;
          }
          if (
            deadline.signal.aborted ||
            (!dispatchReady && availabilityDeadline.signal.aborted) ||
            !stableRequest.isDispatchAuthorized()
          ) {
            throw error;
          }
          if (
            !(error instanceof NodeWorkerLaunchTransportError) ||
            !RETRYABLE_NODE_WORKER_TRANSPORT_CODES.has(error.code)
          ) {
            throw error;
          }
          pollStatus = false;
        }
        delayMs = await waitBeforeRetry({
          delayMs,
          deadline: dispatchReady ? deadline : availabilityDeadline,
        });
      }
    } catch (error) {
      if (restartSignal.aborted && isAgentRunRestartAbortReason(deadline.signal.reason)) {
        // The launcher retains the durable claim; startup must stop this worker before reuse.
        throw deadline.signal.reason;
      }
      if (!dispatchReady && availabilityDeadline.signal.aborted && !deadline.signal.aborted) {
        throw new WorkerRunnerUnavailableError();
      }
      // The node authors this result only after its durable claim stayed absent.
      // Transport dispatch is therefore not launch ambiguity and needs no cancel.
      if (error instanceof WorkerRunnerCapacityError) {
        throw error;
      }
      if (!mayHaveLaunched) {
        throw error;
      }
      let terminal: TerminalNodeWorkerSupervisorReceipt;
      try {
        terminal = await cancelUntilTerminal({ request: stableRequest, expected });
      } catch (cancelError) {
        throw new AggregateError(
          [error, cancelError],
          "node worker launch failed and cancellation could not be confirmed",
          { cause: cancelError },
        );
      }
      if (deadline.signal.aborted || !stableRequest.isDispatchAuthorized()) {
        return terminal;
      }
      throw error;
    } finally {
      availabilityDeadline.dispose();
      deadline.dispose();
    }
  };

  return { launch };
}
