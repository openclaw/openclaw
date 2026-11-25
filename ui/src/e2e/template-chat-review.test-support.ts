import type { TemplatesDraftsReviewResult } from "@openclaw/gateway-protocol";

export const sessionKey = "agent:main:dashboard:template-request";
const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
export const scope = {
  input: "Repository",
  job: "Summarize",
  output: "Brief",
  authority: "Read only",
};
export const reviewed: TemplatesDraftsReviewResult = {
  revision: "a".repeat(64),
  reviewToken: "b".repeat(64),
  publisher: "maker",
  name: "@maker/research-brief",
  displayName: "Research Brief",
  version: "0.1.0",
  description: "Summarize a repository into a concise brief.",
  scope,
  items: [
    {
      id: "file:AGENTS.md",
      kind: "file",
      label: "AGENTS.md",
      detail: "Read only. Never publish without human review.",
      included: true,
    },
    {
      id: "skill:release",
      kind: "skill",
      requirement: { source: "clawhub", ref: "@maker/release-notes", version: "1.2.3" },
      label: "Release notes",
      detail: "Read releases and prepare a concise summary.",
      included: true,
    },
    {
      id: "plugin:github",
      kind: "plugin",
      requirement: { source: "clawhub", ref: "@maker/github", version: "2.0.0" },
      label: "GitHub",
      detail: "github@1.0.0",
      included: true,
    },
    {
      id: "mcp:docs",
      kind: "mcp",
      label: "Docs",
      detail: JSON.stringify({
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: "oauth",
      }),
      included: true,
    },
    {
      id: "automation:brief",
      kind: "automation",
      automation: {
        message:
          "Read the latest repository releases, cite their sources, and prepare a concise morning brief. Never publish without human review.",
        schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
        session: "isolated",
        enabled: false,
      },
      label: "Morning brief",
      detail: "0 9 * * * — disabled when installed",
      included: true,
    },
  ],
  files: [
    { path: "CLAW.md", content: "Summarize the supplied repository. Read only." },
    {
      path: "workspace/AGENTS.md",
      workspacePaths: ["AGENTS.md", "TOOLS.md"],
      content: "Read only. Never publish without human review.\n".repeat(45),
    },
  ],
};
export const historyMessages = [
  {
    role: "user",
    content: [{ type: "text", text: "Create a new template from this agent." }],
    timestamp: 1_790_000_000_000,
  },
  {
    role: "toolResult",
    toolName: "screen",
    toolCallId: "review-template-1",
    content: [{ type: "text", text: "Template ready for review" }],
    timestamp: 1_790_000_002_000,
    details: {
      pluginView: {
        type: "plugin_view",
        pluginId: "openclaw",
        viewId: "template-review",
        version: 1,
        toolName: "screen",
        toolCallId: "review-template-1",
        summary: "Template ready for review",
        payload: { agentId: "main", draftId, sessionKey },
      },
    },
  },
];
