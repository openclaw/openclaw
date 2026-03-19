import { Type } from "@sinclair/typebox";
import { loadGitHubChecks } from "../../github/checks.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const GitHubChecksToolSchema = Type.Object({
  repo: Type.String({ description: "GitHub repository in owner/repo form" }),
  ref: Type.String({ description: "Git reference: branch, tag, or commit SHA" }),
  checkName: Type.Optional(Type.String()),
  maxCheckRuns: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  maxStatuses: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
  token: Type.Optional(Type.String()),
});

export function createGitHubChecksTool(): AnyAgentTool {
  return {
    label: "GitHub Checks",
    name: "github_checks",
    ownerOnly: true,
    description:
      "Fetch GitHub check runs and commit statuses for a repo ref. Good for cron jobs that watch CI and announce concise Slack summaries.",
    parameters: GitHubChecksToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const repo = readStringParam(params, "repo", { required: true });
      const ref = readStringParam(params, "ref", { required: true });
      const checkName = readStringParam(params, "checkName");
      const token = readStringParam(params, "token", { trim: false });
      const maxCheckRuns = readNumberParam(params, "maxCheckRuns", { integer: true });
      const maxStatuses = readNumberParam(params, "maxStatuses", { integer: true });
      const timeoutMs = readNumberParam(params, "timeoutMs", { integer: true });
      const result = await loadGitHubChecks({
        repo,
        ref,
        checkName,
        token,
        maxCheckRuns,
        maxStatuses,
        timeoutMs,
      });
      return jsonResult(result);
    },
  };
}
