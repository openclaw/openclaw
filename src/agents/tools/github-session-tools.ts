import type { AnyAgentTool } from "./common.js";
import { createGitHubIdentityStatusTool } from "./github-identity-status-tool.js";
import { createGitHubPublishTool, createGitHubPullRequestReadTool } from "./github-publish-tool.js";

/** Build only the GitHub tools admitted by the host for this exact session. */
export function createGitHubSessionTools(options: {
  publicationAvailable?: boolean;
  pullRequestReadAvailable?: boolean;
}): AnyAgentTool[] {
  return [
    ...(options.publicationAvailable !== undefined ? [createGitHubIdentityStatusTool()] : []),
    ...(options.publicationAvailable === true ? [createGitHubPublishTool()] : []),
    ...(options.pullRequestReadAvailable === true ? [createGitHubPullRequestReadTool()] : []),
  ];
}
