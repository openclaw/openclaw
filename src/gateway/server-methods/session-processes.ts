import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  SessionsProcessesListParamsSchema,
  SessionsProcessesStopParamsSchema,
  SessionsProcessesListResultSchema,
  SessionsProcessesStopResultSchema,
  type SessionsProcessesListResult,
  type SessionsProcessesStopResult,
} from "../../../packages/gateway-protocol/src/schema/session-processes.js";
import {
  readBackgroundProcesses,
  stopBackgroundProcess,
} from "../../agents/bash-process-observation.js";
import type { WorkerProcessOperation } from "../../worker/worker-process-observation.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { withReadySessionRows, type SessionRowReadView } from "../session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import type { MaterializedRow } from "../session-row-projection-record.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

async function observeProcesses(options: GatewayRequestHandlerOptions, stop: boolean) {
  const { params, context, client, respond } = options;
  const input = stop
    ? Value.Check(SessionsProcessesStopParamsSchema, params)
      ? { ...params }
      : undefined
    : Value.Check(SessionsProcessesListParamsSchema, params)
      ? { ...params }
      : undefined;
  if (!input) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Invalid session process request"),
    );
    return;
  }
  const authority = readGatewayRequestMutationAuthority(options);
  const projection = requireSessionRowProjection(context);
  const queries = (cfg: ReturnType<typeof context.getRuntimeConfig>) => {
    const agent = resolveRequestedSessionAgentId(cfg, input.key, input.agentId);
    if (!agent.ok) {
      throw new SessionMutationAuthorizationChangedError(agent.error);
    }
    return [{ key: input.key, agentId: agent.agentId }];
  };
  const select = (read: SessionRowReadView, captured?: MaterializedRow) => {
    authority.assertCurrent();
    options.sessionMutationAuthorization?.assertCurrent();
    options.sessionAccessAuthority?.assertCurrent();
    const query = queries(read.state.cfg)[0]!;
    const presentation = prepareProjectedSessionPresentation(read, client);
    const denied = presentation.authorizeDescription(query);
    if (denied) {
      throw new SessionMutationAuthorizationChangedError(denied);
    }
    const row = read.describe(query, captured);
    if (
      !row ||
      presentation.sharing.entryFilter?.(row.key, row.entry) === false ||
      (captured &&
        (row.entry.sessionId !== captured.entry.sessionId ||
          row.entry.lifecycleRevision !== captured.entry.lifecycleRevision ||
          row.key !== captured.key ||
          row.agentId !== captured.agentId ||
          row.storeTarget.storePath !== captured.storeTarget.storePath))
    ) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Session process access changed; refresh the conversation.",
        ),
      );
    }
    return row;
  };
  const selected = await withReadySessionRows(projection, queries, select);
  const sessionId = selected.entry.sessionId;
  if ("sessionId" in input && input.sessionId !== sessionId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Session changed; refresh the process list before stopping a process.",
      ),
    );
    return;
  }
  const operation: WorkerProcessOperation =
    "processId" in input
      ? { action: "stop", processId: input.processId, instanceId: input.instanceId }
      : { action: "list" };
  const placement = await context.workerSessionPlacementService?.prepareRuntimeRefresh?.(sessionId);
  const assertCurrent = () => {
    select(projection, selected);
    placement?.assertCurrent();
  };
  try {
    assertCurrent();
    const owner = placement?.placement;
    if (placement?.move || placement?.pendingResult) {
      throw new Error("Session execution is moving; retry after the move completes.");
    }
    let result: SessionsProcessesListResult | SessionsProcessesStopResult;
    if (owner && owner.state !== "local" && owner.state !== "reclaimed") {
      if (
        owner.state !== "active" ||
        owner.executionMode !== "worker-turn" ||
        !context.workerEnvironmentService?.observeProcesses
      ) {
        throw new Error(
          "This session's remote process owner is unavailable. Reconnect its worker and retry.",
        );
      }
      result = await context.workerEnvironmentService.observeProcesses(
        {
          environmentId: owner.environmentId,
          ownerEpoch: owner.activeOwnerEpoch,
          sessionId,
          placementGeneration: owner.generation,
          operation,
        },
        assertCurrent,
        options.signal,
      );
      assertCurrent();
    } else {
      const canonicalKey = resolveSessionStoreKey({
        cfg: context.getRuntimeConfig(),
        sessionKey: selected.key,
        storeAgentId: selected.agentId,
      });
      const scope = {
        scopeKeys: [canonicalKey, selected.key, sessionId],
        agentId: selected.agentId,
      };
      result =
        operation.action === "list"
          ? { sessionId, ...readBackgroundProcesses(scope) }
          : stopBackgroundProcess(scope, operation);
    }
    // Reenter readiness for publication after remote I/O. A stale response cannot leak
    // output after a reset, a sharing change, or an execution placement replacement.
    await withReadySessionRows(projection, queries, () => {
      assertCurrent();
      const expected = stop ? SessionsProcessesStopResultSchema : SessionsProcessesListResultSchema;
      if (
        !Value.Check(expected, result) ||
        (!stop && "sessionId" in result && result.sessionId !== sessionId)
      ) {
        throw new Error("Worker returned an invalid process observation; reconnect and retry.");
      }
      if ("processes" in result) {
        const stopParams = { key: selected.key, agentId: selected.agentId };
        const stopScope = authorizeOperatorScopesForMethod(
          "sessions.processes.stop",
          client?.connect.scopes ?? [],
          stopParams,
        );
        const canStop = Boolean(
          client &&
          stopScope.allowed &&
          !resolveSessionMutationAuthorization({
            client,
            method: "sessions.processes.stop",
            requestParams: stopParams,
            context,
            // Keep the admitted own-session ceiling, just as dispatch authorization does.
            sessionScope: stopScope.sessionScope,
            sessionRowRead: projection,
          }).error,
        );
        result = {
          ...result,
          processes: result.processes.map((row) => ({ ...row, canStop: row.canStop && canStop })),
        };
      }
      respond(true, result);
    });
  } finally {
    placement?.release();
  }
}

const handler = (stop: boolean) => async (options: GatewayRequestHandlerOptions) => {
  try {
    await observeProcesses(options, stop);
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    options.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "Process observation unavailable; retry shortly.",
      ),
    );
  }
};
export const sessionProcessHandlers: GatewayRequestHandlers = {
  "sessions.processes.list": handler(false),
  "sessions.processes.stop": handler(true),
};
