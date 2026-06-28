// Durable workflow gateway methods expose coordination projections to operator surfaces.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { buildDurableCoordinationProjection } from "../../durable/coordination-projection.js";
import { openDurableWorkflowSqliteStore } from "../../durable/sqlite-store.js";
import type { GatewayRequestHandlers } from "./types.js";

function readWorkflowRunId(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>).workflowRunId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const durableHandlers: GatewayRequestHandlers = {
  "durable.coordination.get": ({ params, respond }) => {
    const workflowRunId = readWorkflowRunId(params);
    if (!workflowRunId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "workflowRunId is required."),
      );
      return;
    }
    const store = openDurableWorkflowSqliteStore();
    try {
      const run = store.getRun(workflowRunId);
      if (!run) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `durable workflow run not found: ${workflowRunId}`,
          ),
        );
        return;
      }
      respond(true, {
        projection: buildDurableCoordinationProjection({
          run,
          steps: store.listSteps(workflowRunId),
          childLinks: store.listChildLinks(workflowRunId),
          refs: store.listRefs(workflowRunId),
        }),
      });
    } finally {
      store.close();
    }
  },
};
