import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerEnvironmentPlacementFacts } from "./placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type {
  WorkerSessionPlacementRetirement,
  WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  isCurrentActiveWorkerEnvironment,
  isFailedWorkerPlacementEnvironmentGone,
  matchesWorkerPlacementTarget,
  type WorkerPlacementCancellationTarget,
} from "./placement-target.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerEnvironmentServiceContract,
  WorkerPlacementDispatchContract,
  WorkerPlacementReclaimSourceCheck,
  WorkerPlacementRedispatch,
} from "./service-contract.js";

export type SessionWorkerPlacementContext = {
  workerEnvironmentService?: Pick<WorkerEnvironmentServiceContract, "get">;
  workerPlacementDispatchService?: Pick<WorkerPlacementDispatchContract, "reclaim">;
  workerSessionPlacementService?: Pick<WorkerSessionPlacementStore, "getMany"> &
    Partial<
      Pick<
        WorkerSessionPlacementStore,
        | "getManyAsync"
        | "retireSessionPlacement"
        | "listForReconcile"
        | "listAsync"
        | "retireSessionPlacementAsync"
        | "prepareRuntimeRefresh"
      >
    >;
};

type PlacementMutationAction = "fork" | "reset" | "restore" | "rewind" | "switch";
type Placement = WorkerSessionPlacementRecord;
type PlacementState = Placement["state"];
type PlacementOwner = WorkerPlacementCancellationTarget &
  Pick<Placement, "sessionId" | "sessionKey" | "agentId" | "executionMode">;

class SessionWorkerPlacementMutationError extends Error {
  constructor(state: PlacementState, action: PlacementMutationAction, key: string) {
    super(`Session ${key} cannot ${action} while cloud worker placement is ${state}.`);
  }
}

export class SessionWorkerPlacementStopError extends Error {
  constructor(state: PlacementState, action: "archive" | "delete" | "recover", key: string) {
    const recovery =
      state === "failed"
        ? "Worker cleanup is still pending. Use Stop cloud worker to retry cleanup; if stopping fails, resolve the provider error before trying again."
        : "Wait for the cloud worker transition to finish before trying again.";
    super(`Session ${key} cannot ${action} while cloud worker placement is ${state}. ${recovery}`);
  }
}

type SessionWorkerPlacementMutationGuard =
  | { status: "allowed" }
  | { status: "blocked"; error: SessionWorkerPlacementMutationError }
  | ({ status: "retirement-required" } & WorkerSessionPlacementRetirement);

type SessionWorkerPlacementMutationParams = {
  action: PlacementMutationAction;
  context: SessionWorkerPlacementContext;
  key: string;
  sessionId: string | undefined;
};

type RetirablePlacement = Extract<Placement, { state: "local" | "reclaimed" | "failed" }>;
type FailedPlacement = Extract<Placement, { state: "failed" }>;

export function canRedispatchFailedWorkerPlacement(
  placement: FailedPlacement,
  environment: WorkerEnvironmentPlacementFacts | undefined,
): boolean {
  return Boolean(
    placement.activeOwnerEpoch !== null &&
    !placement.turnClaim &&
    environment &&
    environment.environmentId === placement.environmentId &&
    (environment.providerId !== DEVICE_WORKER_PROVIDER_ID || environment.nodeDeviceId) &&
    isFailedWorkerPlacementEnvironmentGone({
      placement,
      environmentService: { get: () => environment },
    }),
  );
}

function isWorkerPlacementSafeForMutation(
  context: SessionWorkerPlacementContext,
  placement: Placement,
): placement is RetirablePlacement {
  if (placement.state === "failed") {
    return isFailedWorkerPlacementEnvironmentGone({
      environmentService: context.workerEnvironmentService,
      placement,
    });
  }
  return placement.state === "local" || placement.state === "reclaimed";
}

export function resolveWorkerPlacementArchiveRestoreError(params: {
  context: SessionWorkerPlacementContext;
  key: string;
  placement: WorkerSessionPlacementRecord | undefined;
}): string | undefined {
  if (
    !params.placement ||
    (params.placement.state === "failed" && !params.placement.turnClaim) ||
    isWorkerPlacementSafeForMutation(params.context, params.placement)
  ) {
    return undefined;
  }
  return `Session ${params.key} cannot change archive state while cloud worker placement is ${params.placement.state}.`;
}

function resolveSessionWorkerPlacementMutationGuard(
  params: SessionWorkerPlacementMutationParams,
): SessionWorkerPlacementMutationGuard {
  const placement = readSessionWorkerPlacement(params);
  if (!placement) {
    return { status: "allowed" };
  }

  if (isWorkerPlacementSafeForMutation(params.context, placement)) {
    if (params.action === "reset") {
      return {
        status: "retirement-required",
        sessionId: placement.sessionId,
        expectedState: placement.state,
        expectedGeneration: placement.generation,
      };
    }
    // History rewrites rotate the session identity and would strand stopped cloud affinity.
    if (placement.state === "local" || params.action === "fork") {
      return { status: "allowed" };
    }
  }
  return {
    status: "blocked",
    error: new SessionWorkerPlacementMutationError(placement.state, params.action, params.key),
  };
}

export function retireSessionWorkerPlacementBeforeMutation(
  params: SessionWorkerPlacementMutationParams,
): SessionWorkerPlacementMutationError | undefined {
  const guard = resolveSessionWorkerPlacementMutationGuard(params);
  if (guard.status !== "retirement-required") {
    return guard.status === "blocked" ? guard.error : undefined;
  }
  const retirementService = params.context.workerSessionPlacementService;
  if (!retirementService?.retireSessionPlacement) {
    throw new Error("Worker session placement retirement service is unavailable");
  }
  retirementService.retireSessionPlacement(guard);
  return undefined;
}

export function resolveSessionWorkerPlacementMutationError(
  params: SessionWorkerPlacementMutationParams,
): SessionWorkerPlacementMutationError | undefined {
  const guard = resolveSessionWorkerPlacementMutationGuard(params);
  return guard.status === "blocked" ? guard.error : undefined;
}

function readSessionWorkerPlacement(params: {
  context: SessionWorkerPlacementContext;
  sessionId?: string;
}): Placement | undefined {
  return params.sessionId
    ? params.context.workerSessionPlacementService
        ?.getMany([params.sessionId])
        .get(params.sessionId)
    : undefined;
}

export async function readSessionWorkerPlacementAsync(params: {
  context: SessionWorkerPlacementContext;
  sessionId?: string;
}): Promise<Placement | undefined> {
  const service = params.context.workerSessionPlacementService;
  if (!params.sessionId || !service) {
    return undefined;
  }
  // Released Gateway contexts may supply only the synchronous placement reader.
  const placements = service.getManyAsync
    ? await service.getManyAsync([params.sessionId])
    : service.getMany([params.sessionId]);
  return placements.get(params.sessionId);
}

function samePlacementOwner(
  expected: PlacementOwner | undefined,
  current: PlacementOwner | undefined,
): boolean {
  return (
    current?.sessionId === expected?.sessionId &&
    current?.sessionKey === expected?.sessionKey &&
    current?.agentId === expected?.agentId &&
    matchesWorkerPlacementTarget(current, expected) &&
    current?.executionMode === expected?.executionMode
  );
}

/** Retain the exact stopped placement across fallible workspace or session mutations. */
function createSessionWorkerPlacementMutationCheck(
  params: Pick<SessionWorkerPlacementMutationParams, "context" | "sessionId">,
  expected: Placement | undefined,
  operation: "mutation" | "retirement" = "mutation",
) {
  const assertPlacement = (current: Placement | undefined) => {
    if (
      !samePlacementOwner(expected, current) ||
      current?.turnClaim ||
      (current && !isWorkerPlacementSafeForMutation(params.context, current))
    ) {
      throw new Error(`Worker session placement ${params.sessionId} changed before ${operation}`);
    }
  };
  assertPlacement(expected);
  // SDK and foreign writers can bypass retained owner observations. Keep the
  // existing exact native predicate immediately before downstream effects.
  return () => assertPlacement(readSessionWorkerPlacement(params));
}

export function prepareSessionWorkerPlacementMutationCheck(
  params: Pick<SessionWorkerPlacementMutationParams, "context" | "sessionId">,
  operation: "mutation" | "retirement" = "mutation",
) {
  return createSessionWorkerPlacementMutationCheck(
    params,
    readSessionWorkerPlacement(params),
    operation,
  );
}

export async function prepareSessionWorkerPlacementMutationCheckAsync(
  params: Pick<SessionWorkerPlacementMutationParams, "context" | "sessionId">,
) {
  return createSessionWorkerPlacementMutationCheck(
    params,
    await readSessionWorkerPlacementAsync(params),
  );
}

/** Archive visibility can change while a failed placement retains its physical cleanup. */
function createSessionWorkerPlacementArchiveCheck(
  params: Pick<SessionWorkerPlacementMutationParams, "context" | "sessionId">,
  expected: Placement | undefined,
): { assertCurrent: () => void; cleanupPending: boolean } {
  if (expected?.state !== "failed") {
    return {
      assertCurrent: createSessionWorkerPlacementMutationCheck(params, expected),
      cleanupPending: false,
    };
  }
  const assertPlacement = (current: Placement | undefined) => {
    if (!samePlacementOwner(expected, current) || current?.turnClaim) {
      throw new Error(`Worker session placement ${params.sessionId} changed before archive`);
    }
  };
  assertPlacement(expected);
  return {
    assertCurrent: () => assertPlacement(readSessionWorkerPlacement(params)),
    cleanupPending: !isFailedWorkerPlacementEnvironmentGone({
      environmentService: params.context.workerEnvironmentService,
      placement: expected,
    }),
  };
}

export async function prepareSessionWorkerPlacementArchiveCheckAsync(
  params: Pick<SessionWorkerPlacementMutationParams, "context" | "sessionId">,
): Promise<{ assertCurrent: () => void; cleanupPending: boolean }> {
  return createSessionWorkerPlacementArchiveCheck(
    params,
    await readSessionWorkerPlacementAsync(params),
  );
}

/** Capture retirement without erasing cloud affinity before fallible session cleanup. */
export async function prepareSessionWorkerPlacementRetirement(
  params: Pick<SessionWorkerPlacementMutationParams, "context" | "sessionId">,
) {
  const expected = await readSessionWorkerPlacementAsync(params);
  const assertCurrent = createSessionWorkerPlacementMutationCheck(params, expected, "retirement");
  const service = params.context.workerSessionPlacementService;
  const retire = service?.retireSessionPlacementAsync ?? service?.retireSessionPlacement;
  if (expected && !retire) {
    throw new Error("Worker session placement retirement service is unavailable");
  }
  return {
    assertCurrent,
    retire: async () => {
      // Called only after confirmed deletion; orphan reconciliation may have
      // retired this placement while transcript archive publication awaited.
      if (!(await readSessionWorkerPlacementAsync(params))) {
        return;
      }
      assertCurrent();
      if (expected && retire && isWorkerPlacementSafeForMutation(params.context, expected)) {
        await retire({
          sessionId: expected.sessionId,
          expectedState: expected.state,
          expectedGeneration: expected.generation,
        });
      }
    },
  };
}

/** Validate before cancellation; the returned stop remains bound to this placement across drains. */
export function prepareSessionWorkerPlacementStop(params: {
  action: "archive" | "delete" | "recover";
  agentId: string;
  authorize?: () => void;
  context: SessionWorkerPlacementContext;
  sessionId?: string;
  sessionKey: string;
}): { stop: () => Promise<void>; startBeforeDrain: boolean } {
  const { agentId, context, sessionId, sessionKey } = params;
  const expected = readSessionWorkerPlacement(params);
  // Cron run aliases share their base's physical session, even after session-id adoption.
  const matches = (candidate: Placement) =>
    candidate.sessionId === sessionId &&
    (candidate.sessionKey === sessionKey ||
      parseCronRunScopeSuffix(candidate.sessionKey).baseSessionKey === sessionKey) &&
    candidate.agentId === agentId;
  if (expected && !matches(expected)) {
    throw new Error(`Session ${sessionKey} cloud worker placement identity changed.`);
  }
  if (
    expected &&
    (expected.state === "reconciling" ||
      (params.action === "recover" &&
        expected.state !== "active" &&
        !isWorkerPlacementSafeForMutation(context, expected)))
  ) {
    throw new SessionWorkerPlacementStopError(expected.state, params.action, sessionKey);
  }
  const beforeDrain: WorkerPlacementReclaimSourceCheck = (predecessor) => {
    params.authorize?.();
    const current = readSessionWorkerPlacement(params);
    const owned =
      expected && predecessor && predecessor.generation > expected.generation
        ? { ...expected, ...predecessor }
        : expected;
    if (!samePlacementOwner(owned, current)) {
      throw new Error(`Session ${sessionKey} cloud worker placement identity changed.`);
    }
  };
  const stop = async () => {
    beforeDrain();
    if (
      !expected ||
      (params.action === "archive" && expected.state === "failed") ||
      isWorkerPlacementSafeForMutation(context, expected) ||
      !sessionId
    ) {
      return;
    }
    if (!context.workerPlacementDispatchService?.reclaim) {
      throw new Error(`Session ${sessionKey} cloud worker reclaim is unavailable.`);
    }
    // The dispatch owner rechecks source eligibility before its own drain, and
    // caller authority throughout reconciliation. Never force-abandon unsynced work.
    const reclaimed = await context.workerPlacementDispatchService.reclaim(
      { agentId, sessionId, sessionKey: expected.sessionKey },
      params.authorize,
      beforeDrain,
    );
    params.authorize?.();
    const settled = readSessionWorkerPlacement(params);
    if (
      (reclaimed.state !== "reclaimed" && reclaimed.state !== "local") ||
      !matches(reclaimed) ||
      !samePlacementOwner(reclaimed, settled)
    ) {
      throw new Error(`Session ${sessionKey} cloud worker reclaim identity changed.`);
    }
  };
  return {
    stop,
    startBeforeDrain:
      expected?.state === "requested" ||
      expected?.state === "provisioning" ||
      expected?.state === "syncing" ||
      expected?.state === "starting",
  };
}

/** Initial placement, readiness, and recovery consume the same recorded destination. */
export async function ensureWorkerSessionPlacement(params: {
  request: WorkerPlacementDispatchRequest;
  placements: Pick<WorkerSessionPlacementStore, "prepareSessionPlacement">;
  environments: { get(environmentId: string): WorkerEnvironmentRecord | undefined };
  dispatch: WorkerPlacementDispatchContract["dispatch"];
  startDispatch: (
    ...args: Parameters<WorkerPlacementDispatchContract["dispatch"]>
  ) => Promise<WorkerSessionPlacementRecord>;
  waitForInitialPlacement: (
    placement: WorkerSessionPlacementRecord,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  redispatchPlacement: WorkerPlacementRedispatch;
  prepareWorkspace: (canPrepare: () => boolean) => Promise<void>;
  assertCurrent: () => void;
  authorizeDispatch: () => void;
  onTransition?: Parameters<WorkerPlacementDispatchContract["dispatch"]>[1];
  signal?: AbortSignal;
  waitForReady?: boolean;
}): Promise<{ assertCurrent: () => void; release: () => void }> {
  const { request } = params;
  const prepared = await params.placements.prepareSessionPlacement(request.sessionId);
  try {
    const read = () => {
      params.signal?.throwIfAborted();
      params.assertCurrent();
      const placement = prepared.current();
      if (!placement || placement.state === "local") {
        return placement;
      }
      if (
        placement.agentId !== request.agentId ||
        placement.sessionKey !== request.sessionKey ||
        placement.executionMode !== request.executionMode
      ) {
        throw new Error(
          "The existing placement conflicts with worker execution; repair its recorded owner before retrying.",
        );
      }
      const environment = placement.environmentId
        ? params.environments.get(placement.environmentId)
        : undefined;
      if (!environment && placement.state === "failed" && placement.environmentId) {
        throw new Error(
          "The session's recorded worker profile is unavailable; repair its environment record before retrying. Its workspace will not be moved automatically.",
        );
      }
      if (environment && environment.profileId !== request.profileId) {
        throw new Error(
          "The session is bound to another worker profile; its workspace will not be moved automatically.",
        );
      }
      return placement;
    };
    const assertReady = () => {
      const placement = read();
      const environment = placement?.environmentId
        ? params.environments.get(placement.environmentId)
        : undefined;
      if (
        placement?.state !== "active" ||
        !isCurrentActiveWorkerEnvironment(placement, environment)
      ) {
        throw new Error(
          "Worker placement is not ready; inspect its setup error or Stop the failed worker before retrying.",
        );
      }
    };
    const useRecorded = async () => {
      const placement = read();
      if (
        !placement ||
        placement.state === "local" ||
        (placement.state === "failed" &&
          placement.activeOwnerEpoch === null &&
          isFailedWorkerPlacementEnvironmentGone({
            placement,
            environmentService: params.environments,
          }))
      ) {
        return false;
      }
      if (
        placement.state === "reclaimed" ||
        (placement.state === "failed" && placement.activeOwnerEpoch !== null)
      ) {
        await params.redispatchPlacement(placement, {
          assertCurrent: params.assertCurrent,
          signal: params.signal,
        });
        assertReady();
      } else if (params.waitForReady !== false) {
        if (["requested", "provisioning", "syncing", "starting"].includes(placement.state)) {
          await params.waitForInitialPlacement(placement, params.signal);
        }
        assertReady();
      }
      return true;
    };
    const assertDestinationCurrent = () => {
      read();
    };
    if (await useRecorded()) {
      return { assertCurrent: assertDestinationCurrent, release: prepared.release };
    }
    await params.prepareWorkspace(() => {
      const placement = read();
      if (placement?.turnClaim) {
        throw new Error("A local turn is still active; stop it before worker setup.");
      }
      return (
        !placement ||
        placement.state === "local" ||
        (placement.state === "failed" &&
          placement.activeOwnerEpoch === null &&
          isFailedWorkerPlacementEnvironmentGone({
            placement,
            environmentService: params.environments,
          }))
      );
    });
    if (await useRecorded()) {
      return { assertCurrent: assertDestinationCurrent, release: prepared.release };
    }
    const placement = read();
    const previousEnvironment =
      placement?.state === "failed" && placement.environmentId
        ? params.environments.get(placement.environmentId)
        : undefined;
    const dispatch = params.waitForReady === false ? params.startDispatch : params.dispatch;
    await dispatch(
      {
        ...request,
        ...(previousEnvironment
          ? {
              inheritedProfile: {
                providerId: previousEnvironment.providerId,
                profileSnapshot: previousEnvironment.profileSnapshot,
              },
            }
          : {}),
      },
      params.onTransition,
      params.authorizeDispatch,
      params.signal,
    );
    read();
    if (params.waitForReady !== false) {
      assertReady();
    }
    return { assertCurrent: assertDestinationCurrent, release: prepared.release };
  } catch (error) {
    prepared.release();
    throw error;
  }
}
