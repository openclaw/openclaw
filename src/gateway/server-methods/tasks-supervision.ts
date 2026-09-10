import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateSupervisionArtifactParams,
  validateSupervisionControlParams,
  validateSupervisionGetParams,
  validateSupervisionListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ensureSupervisedTaskAdmissionOwner } from "../../tasks/supervised-task.admission-owner.js";
import { inspectSupervisedArtifact } from "../../tasks/supervised-task.artifact.js";
import {
  controlSupervisedTask,
  SupervisedTaskControlReplayUnavailableError,
} from "../../tasks/supervised-task.controls.js";
import { getSupervisedTaskSource } from "../../tasks/supervised-task.source.js";
import {
  getSupervisedTaskView,
  listSupervisedTaskViewIds,
} from "../../tasks/supervised-task.view.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { canAccessTaskRequesterSession } from "../task-session-access.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type Request = Parameters<GatewayRequestHandlers["tasks.supervision.get"]>[0];
function authorize(
  request: Pick<Request, "context" | "client">,
  flowId: string,
  access: "read" | "write",
) {
  if (!request.client) {
    throw new Error("Authenticated task access required");
  }
  const source = getSupervisedTaskSource(flowId);
  if (!source) {
    if (!isGatewayAdmin(request.client)) {
      throw new Error("Task not available");
    }
    return;
  }
  const cfg = request.context.getRuntimeConfig();
  if (
    !canAccessTaskRequesterSession({
      cfg,
      client: request.client,
      access,
      task: {
        ownerKey: source.ownerScope,
        requesterAgentId: source.agentId,
        requesterSessionKey: source.sessionKey,
      },
    })
  ) {
    throw new Error("Task not available");
  }
  const current = loadGatewaySessionEntryReadOnly(source.sessionKey, { agentId: source.agentId });
  if (
    (access === "write" || !isGatewayAdmin(request.client)) &&
    (current.entry?.sessionId !== source.sessionId || current.entry.archivedAt !== undefined)
  ) {
    throw new Error("Task source session changed");
  }
}
function unavailable(respond: Request["respond"]) {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Supervised task unavailable or changed; refresh task state before retrying",
    ),
  );
}
export const supervisionHandlers: GatewayRequestHandlers = {
  "tasks.supervision.artifact": async (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(
        params,
        validateSupervisionArtifactParams,
        "tasks.supervision.artifact",
        respond,
      )
    ) {
      return;
    }
    try {
      const result = await inspectSupervisedArtifact(params, () =>
        authorize(request, params.flowId, "read"),
      );
      authorize(request, params.flowId, "read");
      respond(true, result);
    } catch {
      unavailable(respond);
    }
  },
  "tasks.supervision.get": (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(params, validateSupervisionGetParams, "tasks.supervision.get", respond)
    ) {
      return;
    }
    try {
      authorize(request, params.flowId, "read");
      const task = getSupervisedTaskView(params.flowId, Date.now());
      if (!task) {
        throw new Error("Unknown task");
      }
      authorize(request, params.flowId, "read");
      respond(true, { task });
    } catch {
      unavailable(respond);
    }
  },
  "tasks.supervision.list": (request) => {
    const { params, respond, client, context } = request;
    if (
      !assertValidParams(params, validateSupervisionListParams, "tasks.supervision.list", respond)
    ) {
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const current = loadGatewaySessionEntryReadOnly(params.sessionKey, {
        agentId: params.agentId,
      });
      if (
        !client ||
        !current.entry ||
        current.entry.archivedAt !== undefined ||
        !canAccessTaskRequesterSession({
          cfg,
          client,
          access: "read",
          task: {
            ownerKey: params.sessionKey,
            requesterAgentId: params.agentId,
            requesterSessionKey: params.sessionKey,
          },
        })
      ) {
        throw new Error("Session not available");
      }
      const limit = params.limit ?? 50;
      const ids = listSupervisedTaskViewIds({
        ...params,
        sessionId: current.entry.sessionId,
        limit,
      });
      const tasks = ids
        .slice(0, limit)
        .map((flowId) => {
          authorize(request, flowId, "read");
          return getSupervisedTaskView(flowId, Date.now());
        })
        .filter((task) => task !== undefined);
      respond(true, { tasks, ...(ids.length > limit ? { next: ids[limit - 1] } : {}) });
    } catch {
      unavailable(respond);
    }
  },
  "tasks.supervision.control": async (request) => {
    const { params, respond, client } = request;
    if (
      !assertValidParams(
        params,
        validateSupervisionControlParams,
        "tasks.supervision.control",
        respond,
      )
    ) {
      return;
    }
    try {
      authorize(request, params.flowId, "write");
      if (!client) {
        throw new Error("Authenticated task control required");
      }
      const identity = client.authenticatedUserProfile?.profileId
        ? ["profile", client.authenticatedUserProfile.profileId]
        : client.authenticatedUserId
          ? ["user", client.authenticatedUserId]
          : client.pairedClientId
            ? ["paired-client", client.pairedClientId]
            : ["connection", client.connId];
      const actorId = createHash("sha256")
        .update(JSON.stringify(["gateway-supervision", ...identity]))
        .digest("hex");
      const supervisorOwnerId =
        params.action.kind === "resume" ? await ensureSupervisedTaskAdmissionOwner() : undefined;
      const acknowledgement = controlSupervisedTask(
        params,
        {
          actorId,
          supervisorOwnerId,
          assertCurrent: (task) => authorize(request, task.flowId, "write"),
        },
        Date.now(),
      );
      authorize(request, params.flowId, "read");
      const task = getSupervisedTaskView(params.flowId, Date.now());
      if (!task) {
        throw new Error("Task unavailable after control");
      }
      respond(true, { acknowledgement, currentTask: task });
    } catch (error) {
      if (error instanceof SupervisedTaskControlReplayUnavailableError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      } else {
        unavailable(respond);
      }
    }
  },
};
