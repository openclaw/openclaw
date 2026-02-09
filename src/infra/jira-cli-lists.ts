import { runJiraCli } from "./jira-cli.js";

export interface JiraProject {
  key: string;
  name: string;
}

export interface JiraBoard {
  id: string;
  name: string;
  type?: string;
}

export type JiraSprintState = string;

export interface JiraSprint {
  id: string;
  name: string;
  state: JiraSprintState;
}

export interface JiraApplicationOption {
  value: string;
  label: string;
}

export interface JiraAssigneeOption {
  displayName: string;
}

function parsePlainTableLine(line: string): string[] {
  return line.split("|").map((part) => part.trim());
}

export async function listJiraProjects(): Promise<JiraProject[]> {
  const { stdout, exitCode, stderr } = await runJiraCli([
    "project",
    "list",
    "--plain",
    "--no-headers",
    "--delimiter",
    "|",
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "jira project list failed");
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, name] = parsePlainTableLine(line);
      return { key, name };
    });
}

export async function listJiraBoards(projectKey: string): Promise<JiraBoard[]> {
  const { stdout, exitCode, stderr } = await runJiraCli([
    "board",
    "list",
    "--project",
    projectKey,
    "--plain",
    "--no-headers",
    "--delimiter",
    "|",
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "jira board list failed");
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, type] = parsePlainTableLine(line);
      return { id, name, type };
    });
}

/**
 * Lists sprints. Optionally scoped to a board (jira-cli sprint list --board <id>).
 */
export async function listJiraSprints(options?: { boardId?: string }): Promise<JiraSprint[]> {
  const args: string[] = [
    "sprint",
    "list",
    "--table",
    "--plain",
    "--no-headers",
    "--delimiter",
    "|",
  ];
  if (options?.boardId?.trim()) {
    args.push("--board", options.boardId.trim());
  }
  const { stdout, exitCode, stderr } = await runJiraCli(args);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "jira sprint list failed");
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, state] = parsePlainTableLine(line);
      return { id, name, state };
    });
}

export async function listJiraApplicationsFromLabels(
  projectKey: string,
): Promise<JiraApplicationOption[]> {
  const { stdout, exitCode, stderr } = await runJiraCli([
    "issue",
    "list",
    `-p${projectKey}`,
    "--plain",
    "--columns",
    "LABELS",
    "--no-headers",
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "jira issue list for labels failed");
  }
  const seen = new Set<string>();
  const options: JiraApplicationOption[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    for (const label of line.split(/[,\s]+/)) {
      const value = label.trim();
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      options.push({ value, label: value });
    }
  }
  return options;
}

export async function listJiraAssignees(query: string): Promise<JiraAssigneeOption[]> {
  const jql = `assignee ~ "${query}"`;
  const { stdout, exitCode, stderr } = await runJiraCli([
    "issue",
    "list",
    "-q",
    jql,
    "--plain",
    "--columns",
    "ASSIGNEE",
    "--no-headers",
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "jira issue list for assignees failed");
  }
  const seen = new Set<string>();
  const assignees: JiraAssigneeOption[] = [];
  for (const rawLine of stdout.split("\n")) {
    const name = rawLine.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    assignees.push({ displayName: name });
  }
  return assignees;
}
