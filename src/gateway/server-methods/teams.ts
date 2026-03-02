import { loadConfig } from "../../config/config.js";
import {
  sendTeamMessage,
  listTeamMessages,
  markTeamMessagesRead,
} from "../../teams/team-message-store.js";
import {
  createTeamRun,
  getTeamRun,
  listTeamRuns,
  addTeamMember,
  updateMemberState,
  completeTeamRun,
} from "../../teams/team-store.js";
import {
  createTeamTask,
  listTeamTasks,
  updateTeamTask,
  deleteTeamTask,
} from "../../teams/team-task-store.js";
import type { TeamRun } from "../../teams/types.js";
import {
  ErrorCodes,
  errorShape,
  validateTeamRunsCreateParams,
  validateTeamRunsListParams,
  validateTeamRunsGetParams,
  validateTeamRunsCompleteParams,
  validateTeamRunsAddMemberParams,
  validateTeamRunsUpdateMemberParams,
  validateTeamTasksCreateParams,
  validateTeamTasksListParams,
  validateTeamTasksUpdateParams,
  validateTeamTasksDeleteParams,
  validateTeamMessagesSendParams,
  validateTeamMessagesMarkReadParams,
  validateTeamMessagesListParams,
} from "../protocol/index.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

// ─── Team RPC authorization helpers ──────────────────────────────────

/**
 * Returns true if `agentId` is the leader or a registered member of `run`.
 */
function isTeamMemberOrLeader(run: TeamRun, agentId: string): boolean {
  if (run.leader === agentId) {
    return true;
  }
  return run.members.some((m) => m.agentId === agentId);
}

/**
 * Best-effort caller identification from the gateway client connection.
 * Returns the caller's agent ID if it can be determined, or undefined
 * when the caller cannot be identified (e.g. UI/admin connections).
 *
 * Currently the WebSocket `ConnectParams` do not carry a per-agent identity,
 * so this always returns undefined for operator/UI clients.  The function is
 * kept as a seam so future changes (e.g. an `agentId` field in ConnectParams)
 * can be wired in without touching every handler.
 */
function resolveCallerAgentIdFromClient(_client: GatewayClient | null): string | undefined {
  // The gateway client connection does not currently carry an agent-level
  // identity.  Return undefined so the auth check degrades gracefully
  // (best-effort: unidentified callers are allowed through).
  return undefined;
}

/**
 * Assert that the caller is authorized to mutate the given team run.
 *
 * Identification strategy (best-effort, checked in order):
 *   1. An explicit `callerAgentId` extracted from the RPC params (e.g. `from`
 *      on teamMessages.send, or `agentId` on teamRuns.updateMember).
 *   2. The gateway client connection metadata (future-proofed via
 *      `resolveCallerAgentIdFromClient`).
 *   3. If neither source yields an agent ID the check is skipped — this
 *      covers UI / admin / CLI callers that don't have an agent identity.
 *
 * @returns `true` if the request may proceed, `false` if it was rejected
 *          (in which case `respond` has already been called with an error).
 */
function assertTeamAccess(
  teamRunId: string,
  respond: RespondFn,
  client: GatewayClient | null,
  callerAgentIdHint?: string,
): boolean {
  const run = getTeamRun(teamRunId);
  if (!run) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `team run not found: ${teamRunId}`),
    );
    return false;
  }

  // Resolve caller identity: prefer the explicit hint from params, fall back
  // to whatever the client connection provides.
  const callerAgentId = callerAgentIdHint ?? resolveCallerAgentIdFromClient(client);

  // Best-effort: if we cannot determine the caller, allow the request through
  // (covers UI, admin, and CLI callers).
  if (!callerAgentId) {
    return true;
  }

  if (!isTeamMemberOrLeader(run, callerAgentId)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agent "${callerAgentId}" is not a member or leader of team run ${teamRunId}`,
      ),
    );
    return false;
  }

  return true;
}

// ─── Department-based member suggestion ──────────────────────────────

type SuggestedMember = {
  agentId: string;
  name?: string;
  role?: string;
  department?: string;
};

/**
 * Given a leader agent ID, look up the leader's department from config and
 * return all *other* agents in the same department as suggested team members.
 * Returns an empty array when the leader has no department or no peers exist.
 */
function suggestDepartmentMembers(leaderAgentId: string): SuggestedMember[] {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch {
    // Config loading can fail in edge cases (first boot, corrupt file, etc.).
    // Don't block team creation — just return no suggestions.
    return [];
  }

  const agentList = cfg.agents?.list;
  if (!agentList?.length) {
    return [];
  }

  const leader = agentList.find((a) => a.id === leaderAgentId);
  if (!leader?.department) {
    return [];
  }

  const dept = leader.department;
  return agentList
    .filter((a) => a.id !== leaderAgentId && a.department === dept)
    .map((a) => ({
      agentId: a.id,
      ...(a.name ? { name: a.name } : {}),
      ...(a.role ? { role: a.role } : {}),
      ...(a.department ? { department: a.department } : {}),
    }));
}

// ─── Handlers ────────────────────────────────────────────────────────

export const teamsHandlers: GatewayRequestHandlers = {
  // ── Read RPCs (no auth check) ──────────────────────────────────────

  "teamRuns.create": ({ params, respond }) => {
    if (!assertValidParams(params, validateTeamRunsCreateParams, "teamRuns.create", respond)) {
      return;
    }
    const result = createTeamRun({
      name: params.name,
      leader: params.leader,
      leaderSession: params.leaderSession,
    });

    // Suggest department peers so the caller/UI can auto-populate the team.
    const suggestedMembers = suggestDepartmentMembers(params.leader);
    respond(
      true,
      { ...result, ...(suggestedMembers.length ? { suggestedMembers } : {}) },
      undefined,
    );
  },
  "teamRuns.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateTeamRunsListParams, "teamRuns.list", respond)) {
      return;
    }
    const runs = listTeamRuns({ leader: params.leader, state: params.state, limit: params.limit });
    respond(true, runs, undefined);
  },
  "teamRuns.get": ({ params, respond }) => {
    if (!assertValidParams(params, validateTeamRunsGetParams, "teamRuns.get", respond)) {
      return;
    }
    const run = getTeamRun(params.id);
    if (!run) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `team run not found: ${params.id}`),
      );
      return;
    }
    respond(true, run, undefined);
  },

  // ── Mutation RPCs (with team membership authorization) ─────────────

  "teamRuns.complete": ({ params, respond, client }) => {
    if (!assertValidParams(params, validateTeamRunsCompleteParams, "teamRuns.complete", respond)) {
      return;
    }
    // No caller agent ID available in params; auth degrades to team-exists
    // check + client-level identification (best-effort).
    if (!assertTeamAccess(params.id, respond, client)) {
      return;
    }
    const run = completeTeamRun(params.id, params.state);
    if (!run) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `team run not found: ${params.id}`),
      );
      return;
    }
    respond(true, run, undefined);
  },
  "teamRuns.addMember": ({ params, respond, client }) => {
    if (
      !assertValidParams(params, validateTeamRunsAddMemberParams, "teamRuns.addMember", respond)
    ) {
      return;
    }
    // The agent being added (`params.agentId`) is typically not yet a member,
    // so we cannot use it as the caller hint.  Auth degrades to team-exists +
    // client-level identification (best-effort).
    if (!assertTeamAccess(params.teamRunId, respond, client)) {
      return;
    }
    const member = addTeamMember(params.teamRunId, {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      role: params.role,
    });
    if (!member) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `team run not found: ${params.teamRunId}`),
      );
      return;
    }
    respond(true, member, undefined);
  },
  "teamRuns.updateMember": ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateTeamRunsUpdateMemberParams,
        "teamRuns.updateMember",
        respond,
      )
    ) {
      return;
    }
    // `params.agentId` is the member whose state is being updated — treat as
    // the caller identity hint (a member updating its own state, or the leader
    // updating another member).
    if (!assertTeamAccess(params.teamRunId, respond, client, params.agentId)) {
      return;
    }
    const updated = updateMemberState(params.teamRunId, params.agentId, params.state);
    if (!updated) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `team run or member not found: ${params.teamRunId}/${params.agentId}`,
        ),
      );
      return;
    }
    respond(true, { ok: true }, undefined);
  },
  "teamTasks.create": ({ params, respond, client }) => {
    if (!assertValidParams(params, validateTeamTasksCreateParams, "teamTasks.create", respond)) {
      return;
    }
    if (!assertTeamAccess(params.teamRunId, respond, client)) {
      return;
    }
    const task = createTeamTask({
      teamRunId: params.teamRunId,
      subject: params.subject,
      description: params.description ?? "",
    });
    respond(true, task, undefined);
  },

  // ── Read RPCs (no auth check) ──────────────────────────────────────

  "teamTasks.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateTeamTasksListParams, "teamTasks.list", respond)) {
      return;
    }
    const tasks = listTeamTasks(params.teamRunId);
    respond(true, tasks, undefined);
  },

  // ── Mutation RPCs (continued) ──────────────────────────────────────

  "teamTasks.update": ({ params, respond, client }) => {
    if (!assertValidParams(params, validateTeamTasksUpdateParams, "teamTasks.update", respond)) {
      return;
    }
    if (!assertTeamAccess(params.teamRunId, respond, client)) {
      return;
    }
    const task = updateTeamTask(params.teamRunId, params.taskId, {
      owner: params.owner ?? undefined,
      status: params.status,
      subject: params.subject,
      description: params.description,
      blockedBy: params.blockedBy,
    });
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `task not found: ${params.teamRunId}/${params.taskId}`,
        ),
      );
      return;
    }
    respond(true, task, undefined);
  },
  "teamTasks.delete": ({ params, respond, client }) => {
    if (!assertValidParams(params, validateTeamTasksDeleteParams, "teamTasks.delete", respond)) {
      return;
    }
    if (!assertTeamAccess(params.teamRunId, respond, client)) {
      return;
    }
    const deleted = deleteTeamTask(params.teamRunId, params.taskId);
    if (!deleted) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `task not found: ${params.teamRunId}/${params.taskId}`,
        ),
      );
      return;
    }
    respond(true, { ok: true }, undefined);
  },
  "teamMessages.send": ({ params, respond, client }) => {
    if (!assertValidParams(params, validateTeamMessagesSendParams, "teamMessages.send", respond)) {
      return;
    }
    // `params.from` is the sender agent — use as the caller identity hint so
    // we can verify the sender is actually a team member/leader.
    if (!assertTeamAccess(params.teamRunId, respond, client, params.from)) {
      return;
    }
    const msg = sendTeamMessage({
      teamRunId: params.teamRunId,
      from: params.from,
      to: params.to,
      content: params.content,
    });
    respond(true, msg, undefined);
  },
  "teamMessages.markRead": ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateTeamMessagesMarkReadParams,
        "teamMessages.markRead",
        respond,
      )
    ) {
      return;
    }
    // `params.agentId` is the agent marking messages as read — use as the
    // caller identity hint to verify team membership.
    if (!assertTeamAccess(params.teamRunId, respond, client, params.agentId)) {
      return;
    }
    const count = markTeamMessagesRead(params.teamRunId, params.agentId, params.messageIds);
    respond(true, { ok: true, markedCount: count }, undefined);
  },

  // ── Read RPCs (no auth check) ──────────────────────────────────────

  "teamMessages.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateTeamMessagesListParams, "teamMessages.list", respond)) {
      return;
    }
    const messages = listTeamMessages(params.teamRunId, {
      from: params.from,
      to: params.to,
      since: params.since,
    });
    respond(true, messages, undefined);
  },
};
