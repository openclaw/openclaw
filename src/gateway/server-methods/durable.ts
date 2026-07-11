// Durable runtime gateway methods expose coordination projections to operator surfaces.
import {
  ErrorCodes,
  errorShape,
  validateDurableCoordinationGetParams,
  validateDurableLimitParams,
  validateDurableWakeControlParams,
  validateDurableWakeDeliveryAttemptsListParams,
  validateDurableWakeIdParams,
  validateDurableWakeMarkParams,
  validateDurableWakeSupersedeParams,
  type DurableLimitParams,
  type DurableObligationsListResult,
  type DurableCoordinationGetResult,
  type DurableWakeControlParams,
  type DurableWakeControlResult,
  type DurableWakeDeliveryAttemptsListParams,
  type DurableWakeDeliveryAttemptsListResult,
  type DurableWakeIdParams,
  type DurableWakeInspectResult,
  type DurableWakeListResult,
  type DurableWakeMarkParams,
  type DurableWakeSupersedeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isDurableRuntimesEnabled } from "../../durable/config.js";
import { buildDurableCoordinationProjection } from "../../durable/coordination-projection.js";
import { openDurableRuntimeStore } from "../../durable/store-factory.js";
import type { DurableRuntimeStore } from "../../durable/types.js";
import type { GatewayRequestHandlers } from "./types.js";

type DurableStore = ReturnType<typeof openDurableRuntimeStore>;

function validateStoreOpen(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): DurableStore | undefined {
  if (!isDurableRuntimesEnabled()) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime is disabled."),
    );
    return undefined;
  }
  try {
    return openDurableRuntimeStore();
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `Durable runtime store unavailable: ${String(err)}`),
    );
    return undefined;
  }
}

function respondWakeNotFound(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  wakeId: string,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `durable wake not found: ${wakeId}`),
  );
}

function hasWake(store: DurableRuntimeStore, wakeId: string): boolean {
  return Boolean(store.getDurableWake(wakeId));
}

export const durableHandlers: GatewayRequestHandlers = {
  "durable.coordination.get": ({ params, respond }) => {
    if (!isDurableRuntimesEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime is disabled."),
      );
      return;
    }
    if (!validateDurableCoordinationGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runtimeRunId is required."),
      );
      return;
    }
    const { runtimeRunId } = params;
    let store: ReturnType<typeof openDurableRuntimeStore>;
    try {
      store = openDurableRuntimeStore();
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Durable runtime store unavailable: ${String(err)}`),
      );
      return;
    }
    try {
      const run = store.getRun(runtimeRunId);
      if (!run) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `durable runtime run not found: ${runtimeRunId}`),
        );
        return;
      }
      const result: DurableCoordinationGetResult = {
        projection: buildDurableCoordinationProjection({
          run,
          steps: store.listSteps(runtimeRunId),
          childLinks: store.listChildLinks(runtimeRunId),
          refs: store.listRefs(runtimeRunId),
        }),
      };
      respond(true, result);
    } finally {
      store.close();
    }
  },
  "durable.obligations.list": ({ params, respond }) => {
    if (!validateDurableLimitParams(params ?? {})) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "limit must be 1..500."));
      return;
    }
    const listParams = params as DurableLimitParams;
    const store = validateStoreOpen(respond);
    if (!store) {
      return;
    }
    try {
      const result: DurableObligationsListResult = {
        obligations: store.listUnresolvedObligations({ limit: listParams.limit }),
      };
      respond(true, result);
    } finally {
      store.close();
    }
  },
  "durable.wake.list": ({ params, respond }) => {
    if (!validateDurableLimitParams(params ?? {})) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "limit must be 1..500."));
      return;
    }
    const listParams = params as DurableLimitParams;
    const store = validateStoreOpen(respond);
    if (!store) {
      return;
    }
    try {
      const result: DurableWakeListResult = {
        wakes: store.listPendingWakeObligations({ limit: listParams.limit }),
      };
      respond(true, result);
    } finally {
      store.close();
    }
  },
  "durable.wake.inspect": ({ params, respond }) => {
    if (!validateDurableWakeIdParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wakeId is required."));
      return;
    }
    const wakeParams = params as DurableWakeIdParams;
    const store = validateStoreOpen(respond);
    if (!store) {
      return;
    }
    try {
      const inspection = store.getDurableWakeInspection(wakeParams.wakeId);
      if (!inspection) {
        respondWakeNotFound(respond, wakeParams.wakeId);
        return;
      }
      const result: DurableWakeInspectResult = { inspection };
      respond(true, result);
    } finally {
      store.close();
    }
  },
  "durable.wake.deliveryAttempts.list": ({ params, respond }) => {
    if (!validateDurableWakeDeliveryAttemptsListParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wakeId is required."));
      return;
    }
    const attemptParams = params as DurableWakeDeliveryAttemptsListParams;
    const store = validateStoreOpen(respond);
    if (!store) {
      return;
    }
    try {
      if (!hasWake(store, attemptParams.wakeId)) {
        respondWakeNotFound(respond, attemptParams.wakeId);
        return;
      }
      const result: DurableWakeDeliveryAttemptsListResult = {
        deliveryAttempts: store.listWakeDeliveryAttempts({
          wakeId: attemptParams.wakeId,
          limit: attemptParams.limit,
        }),
      };
      respond(true, result);
    } finally {
      store.close();
    }
  },
  "durable.wake.acknowledge": ({ params, respond }) => {
    if (!validateDurableWakeControlParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "wakeId, actorKind, actorRef, reason, and idempotencyKey are required.",
        ),
      );
      return;
    }
    const controlParams = params as DurableWakeControlParams;
    const store = validateStoreOpen(respond);
    if (!store) {
      return;
    }
    try {
      if (!hasWake(store, controlParams.wakeId)) {
        respondWakeNotFound(respond, controlParams.wakeId);
        return;
      }
      const wake = store.acknowledgeDurableWake(controlParams);
      if (!wake) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "durable wake cannot be acknowledged from its current state.",
          ),
        );
        return;
      }
      const result: DurableWakeControlResult = { wake };
      respond(true, result);
    } finally {
      store.close();
    }
  },
  "durable.wake.supersede": ({ params, respond }) => {
    if (!validateDurableWakeSupersedeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "wakeId, actorKind, actorRef, reason, and idempotencyKey are required.",
        ),
      );
      return;
    }
    const controlParams = params as DurableWakeSupersedeParams;
    const store = validateStoreOpen(respond);
    if (!store) {
      return;
    }
    try {
      if (!hasWake(store, controlParams.wakeId)) {
        respondWakeNotFound(respond, controlParams.wakeId);
        return;
      }
      const wake = store.supersedeDurableWake(controlParams);
      if (!wake) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "durable wake cannot be superseded from its current state.",
          ),
        );
        return;
      }
      const result: DurableWakeControlResult = { wake };
      respond(true, result);
    } finally {
      store.close();
    }
  },
  "durable.wake.mark": ({ params, respond }) => {
    if (!validateDurableWakeMarkParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "wakeId, actorKind, actorRef, reason, idempotencyKey, and decisionKind are required.",
        ),
      );
      return;
    }
    const controlParams = params as DurableWakeMarkParams;
    const store = validateStoreOpen(respond);
    if (!store) {
      return;
    }
    try {
      if (!hasWake(store, controlParams.wakeId)) {
        respondWakeNotFound(respond, controlParams.wakeId);
        return;
      }
      const wake = store.markDurableWakeDecisionRequired(controlParams);
      if (!wake) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "durable wake cannot be marked from its current state.",
          ),
        );
        return;
      }
      const result: DurableWakeControlResult = { wake };
      respond(true, result);
    } finally {
      store.close();
    }
  },
};
