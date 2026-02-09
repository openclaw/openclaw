import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import {
  addJiraIssueToSprint,
  assignJiraIssue,
  createJiraIssue,
} from "../../infra/jira-cli-issues.js";
import { listJiraSprints } from "../../infra/jira-cli-lists.js";
import { jsonResult, readStringParam } from "./common.js";

const JiraCreateIssueSchema = Type.Object({
  summary: Type.String({ description: "Short title for the issue" }),
  projectKey: Type.String({ description: "Jira project key (e.g. BRLB)" }),
  description: Type.Optional(Type.String({ description: "Issue body/description" })),
  type: Type.Optional(
    Type.String({ description: "Issue type (e.g. Task, Bug). Default from config." }),
  ),
  priority: Type.Optional(
    Type.String({ description: "Priority (e.g. High, Medium). Default from config." }),
  ),
  application: Type.Optional(
    Type.String({ description: "Application label/component (e.g. ai_language)" }),
  ),
  assignee: Type.Optional(
    Type.String({
      description:
        "Assignee: 'me' for current user, or display name/email. Omit to leave unassigned.",
    }),
  ),
  sprintName: Type.Optional(
    Type.String({
      description: "Add issue to this sprint by name (e.g. 'Sprint 1'). Omit to leave in backlog.",
    }),
  ),
  boardId: Type.Optional(
    Type.String({
      description:
        "Board ID to scope sprint lookup (from jira_list_boards). Omit to match any sprint by name.",
    }),
  ),
});

/**
 * Creates a Jira create-issue tool that uses jira-cli in Docker.
 * Requires JIRA_CLI_CONTAINER_NAME (or default container) to be running with `jira init` configured.
 */
export function createJiraCreateIssueTool(): AnyAgentTool {
  return {
    label: "Jira",
    name: "jira_create_issue",
    description: `Create a Jira issue in a project via jira-cli (Docker). Use when the user asks to create a Jira ticket, story, task, or bug.

Requires: Jira CLI running in Docker (container name from config or JIRA_CLI_CONTAINER_NAME). Run 'jira init' inside the container first.

Provide summary and projectKey. Optionally set description, type, priority, application (e.g. ai_language), assignee ('me' or a name), and sprintName to add to a sprint.`,
    parameters: JiraCreateIssueSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const summary = readStringParam(params, "summary", { required: true });
      const projectKey = readStringParam(params, "projectKey", { required: true });
      const description = readStringParam(params, "description");
      const type = readStringParam(params, "type");
      const priority = readStringParam(params, "priority");
      const application = readStringParam(params, "application");
      const assignee = readStringParam(params, "assignee");
      const sprintName = readStringParam(params, "sprintName");
      const boardId = readStringParam(params, "boardId");

      const key = await createJiraIssue({
        projectKey,
        summary,
        description,
        type,
        priority,
        application,
      });

      const result: {
        key: string;
        projectKey: string;
        application?: string;
        assignee?: string;
        sprintName?: string;
        error?: string;
      } = { key, projectKey };
      if (application) {
        result.application = application;
      }

      if (assignee) {
        try {
          await assignJiraIssue(key, assignee);
          result.assignee = assignee;
        } catch (err) {
          result.error = `Issue created but assign failed: ${String(err)}`;
        }
      }

      if (sprintName) {
        try {
          const sprints = await listJiraSprints(boardId ? { boardId } : undefined);
          const match = sprints.find((s) => s.name.toLowerCase() === sprintName.toLowerCase());
          if (!match) {
            result.error =
              (result.error ? `${result.error}; ` : "") + `Sprint "${sprintName}" not found`;
          } else {
            await addJiraIssueToSprint(match.id, key);
            result.sprintName = sprintName;
          }
        } catch (err) {
          result.error =
            (result.error ? `${result.error}; ` : "") + `Sprint add failed: ${String(err)}`;
        }
      }

      return jsonResult(result);
    },
  };
}
