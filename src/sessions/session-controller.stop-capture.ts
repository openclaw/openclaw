import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { captureGatewayScopeMatcher } from "../gateway/session-runtime-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { ReplyOperation, SessionWorkRun } from "./session-controller.contracts.js";
import {
  captureSessionControllerEffects,
  type CapturedSessionControllerEffect,
} from "./session-controller.lifecycle-work.js";
import {
  captureSessionControllerSourceSettlement,
  type SessionControllerInput,
} from "./session-controller.mailbox.js";
import { findSessionControllerEntries, sessionControllers } from "./session-controller.state.js";
import { rpcSourcesByRunId } from "./session-controller.storage.js";
import { captureSessionTarget, type SessionTarget } from "./session-controller.target.js";

export type SessionControllerStopRunEffect = CapturedSessionControllerEffect & {
  run: SessionWorkRun & { sessionId: string };
};
export type SessionControllerStopEffect =
  | SessionControllerStopRunEffect
  | (CapturedSessionControllerEffect & { run: undefined });

export type SessionControllerStopCapture = Readonly<{
  inputs: readonly SessionControllerInput[];
  queuedInputs: readonly SessionControllerInput[];
  activeInputs: readonly SessionControllerInput[];
  operations: readonly ReplyOperation[];
  effects: readonly SessionControllerStopEffect[];
  /** Select once at the authorized effect; active producers remain captured instances. */
  selectPendingInputs(): readonly SessionControllerInput[];
  /** Actual captured producer/adoption completion, never a signal or timeout proxy. */
  settled: Promise<void>;
}>;

function isStandaloneStopEffect(
  captured: CapturedSessionControllerEffect,
): captured is SessionControllerStopEffect {
  const { effect, run } = captured;
  return (
    !effect.sourceInput &&
    !effect.ref.operation &&
    (!run ||
      (Boolean(run.runId && run.sessionId) &&
        run.controlUiVisible !== false &&
        !rpcSourcesByRunId.has(run.runId)))
  );
}

function inputMatchesStopIncarnation(input: SessionControllerInput, incarnation?: string): boolean {
  if (incarnation === undefined) {
    return true;
  }
  const operation = input.claim?.operation;
  if (operation) {
    return operation.hasOwnedSessionId(incarnation);
  }
  return (
    (input.sourceSessionId ?? input.source?.run.sessionId ?? input.target?.incarnation) ===
    incarnation
  );
}

/** The scope adapter resolves/authorizes targets; this owner captures instances before it yields. */
export function captureSessionControllerStop(params: {
  inputs?: Iterable<SessionControllerInput>;
  operations?: Iterable<ReplyOperation | undefined>;
  effects?: Iterable<CapturedSessionControllerEffect>;
  targets?: Iterable<SessionTarget>;
  pendingCaptures?: Iterable<SessionControllerStopCapture>;
  includeQueued?: boolean;
  includeActive?: boolean;
  resolveGatewayContext?: GatewayContextResolver;
}): SessionControllerStopCapture {
  const matchesGateway = Object.hasOwn(params, "resolveGatewayContext")
    ? captureGatewayScopeMatcher(params.resolveGatewayContext)
    : () => true;
  const inputs = new Set([...(params.inputs ?? [])].filter(matchesGateway));
  const directInputs = [...inputs];
  const targets = [...(params.targets ?? [])];
  const pendingCaptures = [...(params.pendingCaptures ?? [])];
  // Inherited inputs retain the parent's physical filter rather than becoming direct targets.
  const inheritedInputs = new Set(pendingCaptures.flatMap((capture) => capture.inputs));
  const operations = new Set(
    [...(params.operations ?? [])].filter((operation): operation is ReplyOperation =>
      Boolean(operation && matchesGateway(operation)),
    ),
  );
  const effects = new Map(
    [...(params.effects ?? [])]
      .filter(isStandaloneStopEffect)
      .filter((captured) => matchesGateway(captured.effect))
      .map((captured) => [captured.effect, captured]),
  );
  for (const target of targets) {
    if (params.includeActive !== false) {
      for (const captured of captureSessionControllerEffects({
        target,
        requiredSessionId: target.incarnation,
        ...(Object.hasOwn(params, "resolveGatewayContext")
          ? { resolveGatewayContext: params.resolveGatewayContext }
          : {}),
      })) {
        if (isStandaloneStopEffect(captured)) {
          effects.set(captured.effect, captured);
        }
      }
    }
    for (const owner of findSessionControllerEntries(target.sessionKey, target)) {
      if (
        params.includeActive !== false &&
        owner.active &&
        matchesGateway(owner.active) &&
        (target.incarnation === undefined || owner.active.hasOwnedSessionId(target.incarnation))
      ) {
        operations.add(owner.active);
      }
      for (const input of owner.mailbox?.entries ?? []) {
        if (
          input.phase === "consumed" ||
          !matchesGateway(input) ||
          !inputMatchesStopIncarnation(input, target.incarnation)
        ) {
          continue;
        }
        const active = input.claim !== undefined || input.phase === "injecting";
        if (active ? params.includeActive !== false : params.includeQueued !== false) {
          inputs.add(input);
        }
      }
    }
  }
  // Collected siblings keep receipt identity, but the latest eligible source owns aggregate Stop.
  const sourceByOperation = new Map<ReplyOperation, SessionControllerInput>();
  const queuedInputs: SessionControllerInput[] = [];
  const selectedInputs: SessionControllerInput[] = [];
  for (const input of inputs) {
    const operation = input.claim?.operation;
    if (!operation) {
      if (!input.custody.cancellationRetired && input.phase !== "consumed") {
        if ((input.claim && !input.claim.released) || input.phase === "injecting") {
          selectedInputs.push(input);
        } else {
          queuedInputs.push(input);
        }
      }
      continue;
    }
    if (input.custody.cancellationRetired) {
      continue;
    }
    operations.add(operation);
    const prior = sourceByOperation.get(operation);
    if (!prior || prior.sequence < input.sequence) {
      sourceByOperation.set(operation, input);
    }
  }
  const activeInputs = [...selectedInputs, ...sourceByOperation.values()];
  const bareOperations = [...operations].filter((operation) => !sourceByOperation.has(operation));
  // Captured retained sources remain in settlement even when cancellation moved to a sibling.
  const raw = [
    ...[...inputs].map(captureSessionControllerSourceSettlement),
    ...[...operations].map((operation) => operation.ownerSettlement),
    ...[...effects.values()].map((captured) => captured.released),
  ];
  // Defer the aggregate receipt so unselected routing snapshots retain no producer observers.
  let settled: Promise<void> | undefined;
  const isPending = (input: SessionControllerInput) =>
    !input.claim &&
    input.phase !== "injecting" &&
    input.phase !== "consumed" &&
    !input.custody.cancellationRetired &&
    !input.retirementRequested;
  return Object.freeze({
    inputs: Object.freeze([...inputs]),
    queuedInputs: Object.freeze(queuedInputs),
    activeInputs: Object.freeze(activeInputs),
    operations: Object.freeze(bareOperations),
    effects: Object.freeze([...effects.values()]),
    selectPendingInputs() {
      if (params.includeQueued === false) {
        return [];
      }
      const pending = new Set(
        targets.length
          ? []
          : directInputs.filter(
              (input) => !inheritedInputs.has(input) && matchesGateway(input) && isPending(input),
            ),
      );
      for (const captured of pendingCaptures) {
        for (const input of captured.selectPendingInputs()) {
          if (matchesGateway(input) && isPending(input)) {
            pending.add(input);
          }
        }
      }
      for (const target of targets) {
        for (const owner of findSessionControllerEntries(target.sessionKey, target)) {
          for (const input of owner.mailbox?.entries ?? []) {
            const identity = input.target;
            const agentId = input.source?.run.agentId ?? identity?.agentId;
            const sessionKey = input.source?.run.sessionKey ?? identity?.sessionKey;
            if (
              isPending(input) &&
              matchesGateway(input) &&
              identity?.storeScope === target.storeScope &&
              sessionKey !== undefined &&
              target.aliases.includes(sessionKey) &&
              (!target.agentId ||
                (agentId && normalizeAgentId(agentId) === normalizeAgentId(target.agentId))) &&
              inputMatchesStopIncarnation(input, target.incarnation)
            ) {
              pending.add(input);
            }
          }
        }
      }
      return [...pending];
    },
    get settled() {
      if (!settled) {
        settled = Promise.allSettled(raw).then((results) => {
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Session source cleanup failed");
          }
        });
        void settled.catch(() => {});
      }
      return settled;
    },
  });
}

/** Request-local selection for a target discovered by asynchronous routing. */
export function captureSessionControllerStopCandidates(
  params: {
    resolveGatewayContext?: GatewayContextResolver;
  } = {},
) {
  const matchesGateway = Object.hasOwn(params, "resolveGatewayContext")
    ? captureGatewayScopeMatcher(params.resolveGatewayContext)
    : () => true;
  return [...sessionControllers.values()].flatMap((entry) => {
    // Storeless aliases such as `global` overlap agents; group by agent for Stop authority.
    const resources = new Map<
      string | undefined,
      {
        inputs: SessionControllerInput[];
        operations: ReplyOperation[];
        effects: SessionControllerStopEffect[];
      }
    >();
    const group = (agentId: string | undefined) => {
      const captured = resources.get(agentId) ?? { inputs: [], operations: [], effects: [] };
      resources.set(agentId, captured);
      return captured;
    };
    for (const input of entry.mailbox?.entries ?? []) {
      if (input.phase !== "consumed" && matchesGateway(input)) {
        group(
          input.source?.run.agentId ??
            input.claim?.operation?.agentId ??
            input.target?.agentId ??
            entry.target?.agentId,
        ).inputs.push(input);
      }
    }
    if (entry.active && matchesGateway(entry.active)) {
      group(entry.active.agentId ?? entry.target?.agentId).operations.push(entry.active);
    }
    if (entry.target) {
      for (const captured of captureSessionControllerEffects({ target: entry.target, ...params })) {
        if (isStandaloneStopEffect(captured)) {
          group(captured.run?.agentId ?? entry.target.agentId).effects.push(captured);
        }
      }
    }
    return [...resources].map(([agentId, captured]) => ({
      storeScope: entry.target?.storeScope,
      agentId,
      aliases: new Set(entry.aliases),
      capture: captureSessionControllerStop({
        ...captured,
        ...params,
        targets: entry.target ? [captureSessionTarget({ ...entry.target, agentId })] : [],
      }),
    }));
  });
}
