// Durable runtime gateway methods expose coordination projections to operator surfaces.
import {
  ErrorCodes,
  errorShape,
  validateDeliveryAttemptEvidenceListParams,
  validateDurableCoordinationGetParams,
  validateDurableHealthGetParams,
  validateDurableLimitParams,
  validateWakeObligationIdParams,
  type DurableCoordinationGetResult,
  type DurableObligationsListResult,
  type DurableHealthResult,
  type WakeObligationListResult,
  type WakeObligationInspectResult,
  type UncertaintyFactListResult,
  type DeliveryAttemptEvidenceListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { isDurableAuthorityEnabled, isDurableRuntimeEnabled } from "../../durable/config.js";
import { getDurableRuntimeHealthSnapshot } from "../../durable/health.js";
import {
  formatDurableInspectionStoreError,
  projectDurableCoordination,
  projectDurableDeliveryAttempt,
  projectDurableHealthSnapshot,
  projectDurableObligation,
  projectDurableStoreStats,
  projectDurableUncertainty,
  projectDurableWake,
  projectDurableWakeInspection,
} from "../../durable/inspection-projection.js";
import { openDurableRuntimeStoreReadOnly } from "../../durable/store-factory.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function readDurableInspectionStore<T>(
  respond: RespondFn,
  inspect: (store: ReturnType<typeof openDurableRuntimeStoreReadOnly>) => T,
): { value: T } | undefined {
  let store: ReturnType<typeof openDurableRuntimeStoreReadOnly> | undefined;
  try {
    store = openDurableRuntimeStoreReadOnly();
    const value = inspect(store);
    const storeToClose = store;
    store = undefined;
    storeToClose.close();
    return { value };
  } catch (error) {
    try {
      store?.close();
    } catch {
      // Preserve the original inspection failure while keeping private store details off the wire.
    }
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, formatDurableInspectionStoreError(error)),
    );
    return undefined;
  }
}

export const durableHandlers: GatewayRequestHandlers = {
  "durable.health.get": ({ params, respond }) => {
    if (!validateDurableHealthGetParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid health request."));
      return;
    }
    const enabled = isDurableRuntimeEnabled();
    const result: DurableHealthResult = {
      enabled,
      authority: isDurableAuthorityEnabled(),
      ready: false,
      process: projectDurableHealthSnapshot(getDurableRuntimeHealthSnapshot()),
    };
    if (!enabled) {
      respond(true, result);
      return;
    }
    try {
      const store = openDurableRuntimeStoreReadOnly();
      try {
        result.store = projectDurableStoreStats(store.getStats());
        result.ready = true;
      } finally {
        store.close();
      }
    } catch (error) {
      result.storeError = formatDurableInspectionStoreError(error);
    }
    respond(true, result);
  },
  "durable.coordination.get": ({ params, respond }) => {
    if (!validateDurableCoordinationGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runtimeRunId is required."),
      );
      return;
    }
    if (!isDurableRuntimeEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime is disabled."),
      );
      return;
    }
    const { runtimeRunId } = params;
    const inspected = readDurableInspectionStore(respond, (store) => {
      const run = store.getRun(runtimeRunId);
      if (!run) {
        return undefined;
      }
      return {
        projection: projectDurableCoordination({
          run,
          steps: store.listSteps(runtimeRunId),
          childLinks: store.listChildLinks(runtimeRunId),
          refs: store.listRefs(runtimeRunId),
        }),
      } satisfies DurableCoordinationGetResult;
    });
    if (!inspected) {
      return;
    }
    if (!inspected.value) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `durable runtime run not found: ${runtimeRunId}`),
      );
      return;
    }
    respond(true, inspected.value);
  },
  "durable.obligations.list": ({ params, respond }) => {
    if (!validateDurableLimitParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid durable limit."));
      return;
    }
    if (!isDurableRuntimeEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime is disabled."),
      );
      return;
    }
    const inspected = readDurableInspectionStore(
      respond,
      (store): DurableObligationsListResult => ({
        obligations: store
          .listUnresolvedObligations({ limit: params.limit })
          .map(projectDurableObligation),
      }),
    );
    if (inspected) {
      respond(true, inspected.value);
    }
  },
  "durable.wakes.list": ({ params, respond }) => {
    if (!validateDurableLimitParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid durable limit."));
      return;
    }
    if (!isDurableRuntimeEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime is disabled."),
      );
      return;
    }
    const inspected = readDurableInspectionStore(
      respond,
      (store): WakeObligationListResult => ({
        wakes: store.listWakeObligations({ limit: params.limit }).map(projectDurableWake),
      }),
    );
    if (inspected) {
      respond(true, inspected.value);
    }
  },
  "durable.wakes.inspect": ({ params, respond }) => {
    if (!validateWakeObligationIdParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wakeId is required."));
      return;
    }
    if (!isDurableRuntimeEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime is disabled."),
      );
      return;
    }
    const inspected = readDurableInspectionStore(respond, (store) => {
      const inspection = store.getWakeObligationInspection(params.wakeId);
      return inspection
        ? ({
            inspection: projectDurableWakeInspection(inspection),
          } satisfies WakeObligationInspectResult)
        : undefined;
    });
    if (!inspected) {
      return;
    }
    if (!inspected.value) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `wake obligation not found: ${params.wakeId}`),
      );
      return;
    }
    respond(true, inspected.value);
  },
  "durable.uncertainty.list": ({ params, respond }) => {
    if (!validateDurableLimitParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid durable limit."));
      return;
    }
    if (!isDurableRuntimeEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime is disabled."),
      );
      return;
    }
    const inspected = readDurableInspectionStore(
      respond,
      (store): UncertaintyFactListResult => ({
        uncertaintyFacts: store
          .listUnresolvedUncertaintyFacts({ limit: params.limit })
          .map(projectDurableUncertainty),
      }),
    );
    if (inspected) {
      respond(true, inspected.value);
    }
  },
  "durable.deliveryAttempts.list": ({ params, respond }) => {
    if (!validateDeliveryAttemptEvidenceListParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wakeId is required."));
      return;
    }
    if (!isDurableRuntimeEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime is disabled."),
      );
      return;
    }
    const inspected = readDurableInspectionStore(
      respond,
      (store): DeliveryAttemptEvidenceListResult => ({
        deliveryAttemptEvidence: store
          .listDeliveryAttemptEvidence({
            wakeId: params.wakeId,
            limit: params.limit,
          })
          .map(projectDurableDeliveryAttempt),
      }),
    );
    if (inspected) {
      respond(true, inspected.value);
    }
  },
};
