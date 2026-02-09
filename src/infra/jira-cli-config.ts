import { danger } from "../globals.js";
import { logError } from "../logger.js";

export type JiraApplicationFieldType = "label" | "component" | "customField";

export interface JiraCliConfig {
  containerName: string;
  defaultIssueType: string;
  defaultPriority: string;
  applicationFieldType: JiraApplicationFieldType;
  /**
   * For label/component, this is informational only.
   * For customField, this should be the Jira custom field ID (e.g. "customfield_12345").
   */
  applicationFieldKey: string;
  favoriteProjects: string[];
  defaultBoards: Record<string, string>;
}

/** Set to "customField" and use JIRA_APPLICATION_FIELD_KEY so "application" goes to Jira Applications custom field instead of Labels. */
const applicationFieldTypeEnv = process.env.JIRA_APPLICATION_FIELD_TYPE?.trim().toLowerCase();
const applicationFieldKeyEnv = process.env.JIRA_APPLICATION_FIELD_KEY?.trim();

const defaultConfig: JiraCliConfig = {
  containerName: process.env.JIRA_CLI_CONTAINER_NAME || "jira-cli",
  defaultIssueType: "Task",
  defaultPriority: "Medium",
  applicationFieldType:
    applicationFieldTypeEnv === "component"
      ? "component"
      : applicationFieldTypeEnv === "customfield"
        ? "customField"
        : "label",
  applicationFieldKey: applicationFieldKeyEnv || "application",
  favoriteProjects: ["BRLB"],
  defaultBoards: {
    BRLB: "AI Vision Language",
  },
};

let cachedConfig: JiraCliConfig | null = null;

export function getJiraCliConfig(): JiraCliConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const containerName = defaultConfig.containerName.trim();
  if (!containerName) {
    const message =
      "Jira CLI config missing containerName. Set JIRA_CLI_CONTAINER_NAME in the environment or adjust defaultConfig.";
    logError(danger(message));
    throw new Error(message);
  }

  cachedConfig = {
    ...defaultConfig,
    containerName,
  };

  return cachedConfig;
}
