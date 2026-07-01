// Durable runtime gateway methods expose coordination projections to operator surfaces.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { isDurableRuntimesEnabled } from "../../durable/config.js";
import { buildDurableCoordinationProjection } from "../../durable/coordination-projection.js";
import { openDurableRuntimeStore } from "../../durable/store-factory.js";
import type { GatewayRequestHandlers } from "./types.js";

function readRuntimeRunId(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>).runtimeRunId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const durableHandlers: GatewayRequestHandlers = {
  "durable.coordination.get": ({ params, respond }) => {
    if (!isDurableRuntimesEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Durable runtime are disabled."),
      );
      return;
    }
    const runtimeRunId = readRuntimeRunId(params);
    if (!runtimeRunId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runtimeRunId is required."),
      );
      return;
    }
    const store = openDurableRuntimeStore();
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
      respond(true, {
        projection: buildDurableCoordinationProjection({
          run,
          steps: store.listSteps(runtimeRunId),
          childLinks: store.listChildLinks(runtimeRunId),
          refs: store.listRefs(runtimeRunId),
        }),
      });
    } finally {
      store.close();
    }
  },
};
