import { randomUUID } from "node:crypto";
import {
  jsonResult,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { hasSessionControlAuthority } from "./sessions-operator-authority.js";
import { prepareSessionToolControlTarget } from "./sessions-tool-control.js";

export async function resumeSessionToolGoal(
  target: Omit<
    Parameters<typeof prepareSessionToolControlTarget>[0],
    "operation" | "restricted"
  > & { isRequesterSession: boolean },
  params: Record<string, unknown>,
  gatewayRequest: AgentToolGatewayRequestCaller,
  signal?: AbortSignal,
) {
  // A note explains intent; only the host-issued operator capability authorizes control.
  if (!hasSessionControlAuthority()) {
    throw new ToolAuthorizationError("Goal Resume requires a current operator write grant");
  }
  const expectedSessionId = readToolStringParam(params, "expectedSessionId", {
    required: true,
  });
  const note = readToolStringParam(params, "note", { required: true });
  if (target.isRequesterSession) {
    throw new ToolInputError(
      "To resume this session's goal, finish the current reply and use Goal Resume.",
    );
  }
  const control = await prepareSessionToolControlTarget({
    ...target,
    operation: "resume",
    restricted: true,
    expectedSessionId,
  });
  try {
    if (control.goal?.status !== "blocked") {
      throw new ToolInputError(
        "goal_resume requires an existing blocked goal; review its current status.",
      );
    }
    const result = await gatewayRequest({
      method: "sessions.goal.update",
      signal,
      sessionMutationCommitGuard: control.assertCurrent,
      params: {
        sessionKey: target.key,
        agentId: target.agentId,
        sessionId: control.sessionId,
        goalId: control.goal.id,
        action: "resume",
        expectedStatus: "blocked",
        note,
        operationId: randomUUID(),
        issuedAtMs: Date.now(),
      },
    });
    return jsonResult(result);
  } finally {
    control.release();
  }
}
