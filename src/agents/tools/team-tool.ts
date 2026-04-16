import { Type } from "@sinclair/typebox";
import {
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  updateTeam,
} from "../team-registry.js";
import {
  type AnyAgentTool,
  jsonResult,
  readStringArrayParam,
  readStringParam,
  ToolInputError,
} from "./common.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";

const TEAM_ACTIONS = ["list", "create", "get", "update", "delete"] as const;

export const TeamToolSchema = Type.Object(
  {
    action: Type.Union(TEAM_ACTIONS.map((entry) => Type.Literal(entry))),
    teamId: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    members: Type.Optional(Type.Array(Type.String())),
    labels: Type.Optional(Type.Array(Type.String())),
    tasks: Type.Optional(
      Type.Array(
        Type.Object(
          {
            taskId: Type.Optional(Type.String()),
            task_id: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
      ),
    ),
  },
  { additionalProperties: true },
);

function readTaskIdsParam(params: Record<string, unknown>): string[] | undefined {
  const tasks = params.tasks;
  if (!Array.isArray(tasks)) {
    return undefined;
  }
  const taskIds = tasks
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
      if (taskId) {
        return taskId;
      }
      const taskIdSnake = typeof record.task_id === "string" ? record.task_id.trim() : "";
      return taskIdSnake || null;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (taskIds.length === 0) {
    return undefined;
  }
  return Array.from(new Set(taskIds));
}

export function createTeamTool(): AnyAgentTool {
  return {
    name: "team",
    label: "team",
    ownerOnly: isOpenClawOwnerOnlyCoreToolName("team"),
    description:
      "Manage in-memory agent teams (list/create/get/update/delete) for coordination workflows.",
    parameters: TeamToolSchema,
    execute: async (_toolCallId, input) => {
      const params = (input ?? {}) as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as
        | "list"
        | "create"
        | "get"
        | "update"
        | "delete";

      switch (action) {
        case "list": {
          const teams = listTeams();
          return jsonResult({
            status: "ok",
            action,
            count: teams.length,
            teams,
          });
        }
        case "create": {
          const name = readStringParam(params, "name", { required: true, label: "name" });
          const team = createTeam({
            teamId: readStringParam(params, "teamId"),
            name,
            description: readStringParam(params, "description"),
            members: readStringArrayParam(params, "members"),
            labels: readStringArrayParam(params, "labels"),
            taskIds: readTaskIdsParam(params),
          });
          return jsonResult({
            status: "ok",
            action,
            team,
            team_id: team.teamId,
            task_count: team.taskIds.length,
            task_ids: team.taskIds,
            name: team.name,
            created_at: team.createdAt,
          });
        }
        case "get": {
          const teamId = readStringParam(params, "teamId", { required: true, label: "teamId" });
          const team = getTeam(teamId);
          if (!team) {
            throw new ToolInputError(`team not found: ${teamId}`);
          }
          return jsonResult({
            status: "ok",
            action,
            team,
          });
        }
        case "update": {
          const teamId = readStringParam(params, "teamId", { required: true, label: "teamId" });
          const team = updateTeam(teamId, {
            name: readStringParam(params, "name"),
            description: readStringParam(params, "description", { allowEmpty: true }),
            members: readStringArrayParam(params, "members"),
            labels: readStringArrayParam(params, "labels"),
            taskIds: readTaskIdsParam(params),
          });
          return jsonResult({
            status: "ok",
            action,
            team,
          });
        }
        case "delete": {
          const teamId = readStringParam(params, "teamId", { required: true, label: "teamId" });
          const existing = getTeam(teamId);
          const deleted = deleteTeam(teamId);
          return jsonResult({
            status: "ok",
            action,
            teamId,
            deleted,
            team_id: teamId,
            name: existing?.name ?? null,
            message: deleted ? "Team deleted" : "Team not found",
          });
        }
        default:
          throw new ToolInputError(`unsupported action: ${String(action)}`);
      }
    },
  };
}
