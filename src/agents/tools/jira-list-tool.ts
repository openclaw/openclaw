import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import {
  listJiraApplicationsFromLabels,
  listJiraAssignees,
  listJiraBoards,
  listJiraProjects,
  listJiraSprints,
} from "../../infra/jira-cli-lists.js";
import { jsonResult, readStringParam } from "./common.js";

const JiraListProjectsSchema = Type.Object({
  // No params; lists all projects.
});

const JiraListBoardsSchema = Type.Object({
  projectKey: Type.String({ description: "Jira project key (e.g. BRLB)" }),
});

const JiraListSprintsSchema = Type.Object({
  boardId: Type.Optional(
    Type.String({
      description: "Board ID to scope sprints (from jira_list_boards). Omit for all.",
    }),
  ),
});

const JiraListApplicationsSchema = Type.Object({
  projectKey: Type.String({ description: "Jira project key to list labels/components from" }),
});

const JiraListAssigneesSchema = Type.Object({
  query: Type.String({ description: "Search query (e.g. 'alice' or 'smith')" }),
});

/**
 * Jira list tools for discovery (projects, boards, sprints, applications, assignees).
 * Requires jira-cli in Docker; use before jira_create_issue to get valid keys/names.
 */
export function createJiraListProjectsTool(): AnyAgentTool {
  return {
    label: "Jira",
    name: "jira_list_projects",
    description:
      "List Jira projects (key and name). Use to discover projectKey for creating issues.",
    parameters: JiraListProjectsSchema,
    execute: async (_toolCallId, _args) => {
      const projects = await listJiraProjects();
      return jsonResult({ projects });
    },
  };
}

export function createJiraListBoardsTool(): AnyAgentTool {
  return {
    label: "Jira",
    name: "jira_list_boards",
    description:
      "List Jira boards for a project. Returns id, name, type. Use board id to scope jira_list_sprints.",
    parameters: JiraListBoardsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const projectKey = readStringParam(params, "projectKey", { required: true });
      const boards = await listJiraBoards(projectKey);
      return jsonResult({ projectKey, boards });
    },
  };
}

export function createJiraListSprintsTool(): AnyAgentTool {
  return {
    label: "Jira",
    name: "jira_list_sprints",
    description:
      "List Jira sprints. Optionally scope by boardId (from jira_list_boards). Use sprint names with jira_create_issue.",
    parameters: JiraListSprintsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const boardId = readStringParam(params, "boardId");
      const sprints = await listJiraSprints(boardId ? { boardId } : undefined);
      return jsonResult({ sprints });
    },
  };
}

export function createJiraListApplicationsTool(): AnyAgentTool {
  return {
    label: "Jira",
    name: "jira_list_applications",
    description:
      "List application options (labels or components) for a project. Use with jira_create_issue application field.",
    parameters: JiraListApplicationsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const projectKey = readStringParam(params, "projectKey", { required: true });
      const applications = await listJiraApplicationsFromLabels(projectKey);
      return jsonResult({ projectKey, applications });
    },
  };
}

export function createJiraListAssigneesTool(): AnyAgentTool {
  return {
    label: "Jira",
    name: "jira_list_assignees",
    description:
      "Search assignees by query (name/email). Use result display names with jira_create_issue assignee.",
    parameters: JiraListAssigneesSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const assignees = await listJiraAssignees(query);
      return jsonResult({ query, assignees });
    },
  };
}
