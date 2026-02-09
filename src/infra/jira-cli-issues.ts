import { getJiraCliConfig } from "./jira-cli-config.js";
import { runJiraCli } from "./jira-cli.js";

/** Matches Jira issue key (e.g. BRLB-123, PROJ-456). */
const ISSUE_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/;

/** Strip double-quotes so jira-cli argv is not broken by user input. */
function sanitizeJiraCliArg(s: string): string {
  return s.replace(/"/g, "").trim();
}

export interface CreateIssueOptions {
  projectKey: string;
  summary: string;
  description?: string;
  type?: string;
  priority?: string;
  /** Application value (label name, component name, or custom field value). */
  application?: string;
}

/**
 * Creates a Jira issue via jira-cli. Returns the issue key.
 * Throws if creation fails or key cannot be parsed from stdout.
 */
export async function createJiraIssue(options: CreateIssueOptions): Promise<string> {
  const cfg = getJiraCliConfig();
  const type = sanitizeJiraCliArg(options.type ?? cfg.defaultIssueType);
  const priority = sanitizeJiraCliArg(options.priority ?? cfg.defaultPriority);
  const summary = sanitizeJiraCliArg(options.summary);

  const args: string[] = [
    "issue",
    "create",
    `-p${options.projectKey}`,
    `-t${type}`,
    `-s${summary}`,
    `-y${priority}`,
    "--no-input",
  ];

  if (options.application) {
    const application = sanitizeJiraCliArg(options.application);
    if (cfg.applicationFieldType === "label") {
      args.push(`-l${application}`);
    } else if (cfg.applicationFieldType === "component") {
      args.push(`-C${application}`);
    } else if (cfg.applicationFieldType === "customField" && cfg.applicationFieldKey) {
      args.push("--custom", `${cfg.applicationFieldKey}=${application}`);
    }
  }

  const input = options.description ? sanitizeJiraCliArg(options.description) : undefined;
  if (input) {
    args.push("--template", "-");
  }

  const { stdout, stderr, exitCode } = await runJiraCli(args, {
    ...(input && { input }),
  });

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || "jira issue create failed");
  }

  const match = stdout.match(ISSUE_KEY_RE);
  if (!match) {
    throw new Error(`Could not parse issue key from jira output: ${stdout}`);
  }
  return match[1];
}

/**
 * Assigns an issue to a user. Use "me" for self (resolved via `jira me`), or a display name/email.
 */
export async function assignJiraIssue(issueKey: string, assignee: string): Promise<void> {
  let resolved = assignee;
  if (assignee === "me" || assignee.toLowerCase() === "me") {
    const { stdout, exitCode, stderr } = await runJiraCli(["me"]);
    if (exitCode !== 0) {
      throw new Error(stderr || stdout || "jira me failed");
    }
    resolved = stdout.trim();
    if (!resolved) {
      throw new Error("jira me returned empty user");
    }
  }
  const args = ["issue", "assign", issueKey, resolved];
  const { stderr, exitCode, stdout: assignOut } = await runJiraCli(args);
  if (exitCode !== 0) {
    throw new Error(stderr || assignOut || `jira issue assign failed for ${issueKey}`);
  }
}

/**
 * Adds an issue to a sprint by sprint ID.
 */
export async function addJiraIssueToSprint(sprintId: string, issueKey: string): Promise<void> {
  const args = ["sprint", "add", sprintId, issueKey];
  const { stderr, exitCode, stdout: addOut } = await runJiraCli(args);
  if (exitCode !== 0) {
    throw new Error(stderr || addOut || `jira sprint add failed for ${issueKey}`);
  }
}
