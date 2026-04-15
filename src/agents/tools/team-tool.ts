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
  },
  { additionalProperties: true },
);

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
          });
          return jsonResult({
            status: "ok",
            action,
            team,
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
          });
          return jsonResult({
            status: "ok",
            action,
            team,
          });
        }
        case "delete": {
          const teamId = readStringParam(params, "teamId", { required: true, label: "teamId" });
          const deleted = deleteTeam(teamId);
          return jsonResult({
            status: "ok",
            action,
            teamId,
            deleted,
          });
        }
        default:
          throw new ToolInputError(`unsupported action: ${action}`);
      }
    },
  };
}
