// Durable runtime gateway methods expose coordination projections to operator surfaces.
import {
  ErrorCodes,
  errorShape,
  validateDurableCoordinationGetParams,
  type DurableCoordinationGetResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { isDurableRuntimesEnabled } from "../../durable/config.js";
import { buildDurableCoordinationProjection } from "../../durable/coordination-projection.js";
import { openDurableRuntimeStore } from "../../durable/runtime.js";
import type { GatewayRequestHandlers } from "./types.js";

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
};
