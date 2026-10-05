import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import { GitHubPublicationCreditChangedError } from "./github-publication-failure.js";
import { appendGitHubPublicationMessage } from "./github-publication-git-transport.js";

export async function prepareGitHubPublicationContent(params: {
  row: Pick<
    GitHubPublicationExecutionRow,
    "request_id" | "agent_id" | "session_id" | "session_key" | "branch" | "title"
  >;
  storePath: string;
  accountId: number;
  host: string;
  assertCurrent: () => void;
  description: string;
}) {
  const { row } = params;
  const config = currentGitHubPublicationConfig();
  const prepared = await prepareGitCoauthorAttribution({
    agentId: row.agent_id,
    config,
    excludeIdentity: { host: params.host, accountId: params.accountId },
    host: params.host,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    storePath: params.storePath,
  });
  const title = row.title?.trim() || `Publish ${row.branch}`;
  const trailers = prepared.attribution?.trailers ?? [];
  const credit = prepared.attribution?.logins.map((login) => `- @${login}`).join("\n");
  return {
    title,
    trailers,
    commitMessage: `${appendGitHubPublicationMessage(
      credit ? `${title}\n\nWorked on by:\n${credit}` : title,
      [...trailers, `OpenClaw-Publication: ${row.request_id}`],
    )}\n`,
    assertAction: () => {
      params.assertCurrent();
      if (!prepared.isCurrent()) {
        throw new GitHubPublicationCreditChangedError();
      }
    },
    pullRequestBody() {
      const sessionUrl = resolveControlUiSessionUrl(config, {
        sessionKey: row.session_key,
        fallbackAgentId: row.agent_id,
        exactKey: true,
      });
      const participants = credit ? `\n\n## Worked on by\n\n${credit}` : "";
      const footer = sessionUrl?.startsWith("https://")
        ? `\n\n---\n[View the OpenClaw team session](${sessionUrl})`
        : "";
      return `${params.description}${participants}\n\n<!-- openclaw-publication:${row.request_id} -->${footer}`;
    },
  };
}
