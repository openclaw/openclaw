import { z } from "zod";
import type { LeoIdentityConfig, LeoToolDefinition } from "./types.js";

const OrgParam = z.object({ org: z.string().min(1) });
const QueryParam = z.object({ query: z.string().min(1) });
const EmailParam = z.object({ email: z.string().min(1) });

const CORE_TOOLS: LeoToolDefinition[] = [
  {
    name: "people.search",
    description: "Search the people index by name, role, or team",
    parameters: QueryParam,
  },
  {
    name: "people.lookup",
    description: "Look up a person by email address",
    parameters: EmailParam,
  },
  {
    name: "briefing.generate",
    description: "Generate an executive briefing summary",
    parameters: OrgParam,
  },
];

const GMAIL_TOOLS: LeoToolDefinition[] = [
  {
    name: "gmail.list",
    description: "List recent emails from a Gmail account",
    parameters: OrgParam,
  },
  {
    name: "gmail.read",
    description: "Read a specific email by ID",
    parameters: z.object({ org: z.string(), id: z.string() }),
  },
  {
    name: "gmail.send",
    description: "Send an email via Gmail",
    parameters: z.object({
      org: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
    }),
    requireApproval: true,
  },
];

const CALENDAR_TOOLS: LeoToolDefinition[] = [
  {
    name: "calendar.list",
    description: "List upcoming calendar events",
    parameters: OrgParam,
  },
  {
    name: "calendar.create",
    description: "Create a new calendar event",
    parameters: z.object({
      org: z.string(),
      title: z.string(),
      start: z.string(),
      end: z.string(),
    }),
    requireApproval: true,
  },
];

const SLACK_READ_TOOLS: LeoToolDefinition[] = [
  {
    name: "slack_read.channels",
    description: "List Slack channels in a workspace",
    parameters: OrgParam,
  },
  {
    name: "slack_read.messages",
    description: "Read recent messages from a Slack channel",
    parameters: z.object({ org: z.string(), channel: z.string() }),
  },
];

const ASANA_TOOLS: LeoToolDefinition[] = [
  {
    name: "asana.tasks",
    description: "List tasks from Asana",
    parameters: OrgParam,
  },
];

const MONDAY_TOOLS: LeoToolDefinition[] = [
  {
    name: "monday.boards",
    description: "List Monday.com boards",
    parameters: OrgParam,
  },
];

const GITHUB_TOOLS: LeoToolDefinition[] = [
  {
    name: "github.repos",
    description: "List GitHub repositories for an org",
    parameters: OrgParam,
  },
  {
    name: "github.prs",
    description: "List open pull requests across repos",
    parameters: OrgParam,
  },
];

function hasService(
  config: LeoIdentityConfig,
  key: "slack" | "asana" | "monday" | "github",
): boolean {
  return Object.values(config.orgs).some((org) => org[key] != null);
}

export function registerLeoTools(config: LeoIdentityConfig): LeoToolDefinition[] {
  const tools: LeoToolDefinition[] = [...CORE_TOOLS];

  tools.push(...GMAIL_TOOLS);
  tools.push(...CALENDAR_TOOLS);

  if (hasService(config, "slack")) {
    tools.push(...SLACK_READ_TOOLS);
  }
  if (hasService(config, "asana")) {
    tools.push(...ASANA_TOOLS);
  }
  if (hasService(config, "monday")) {
    tools.push(...MONDAY_TOOLS);
  }
  if (hasService(config, "github")) {
    tools.push(...GITHUB_TOOLS);
  }

  return tools;
}
