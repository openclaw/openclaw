import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { appendPrAttribution, preparePrAttribution } from "../agents/pr-attribution.js";
import { resolveControlUiPublicSessionUrl } from "../config/control-ui-link-base.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import { GitHubPublicationCreditChangedError } from "./github-publication-failure.js";
import { appendGitHubPublicationMessage } from "./github-publication-git-transport.js";

export async function prepareGitHubPublicationContent(params: {
  row: Pick<
    GitHubPublicationExecutionRow,
    "request_id" | "agent_id" | "session_id" | "session_key" | "branch" | "title"
  >;
  requesterProfileId?: string;
  storePath: string;
  accountId: number;
  host: string;
  assertCurrent: () => void;
  // Reuse the retained publication owner; do not open another session read.
  readCurrentEntry: () => InternalSessionEntry | undefined;
  description: string;
}) {
  const { row } = params;
  const config = currentGitHubPublicationConfig();
  const initialEntry = params.readCurrentEntry();
  const initialShare = resolveSessionPublicShare(initialEntry);
  const sessionUrl = resolveControlUiPublicSessionUrl(config, {
    sessionKey: row.session_key,
    sessionId: row.session_id,
    agentId: row.agent_id,
    entry: initialEntry,
  });
  const description = params.description
    .replace(/(?:\s*---\s*\n\[View the OpenClaw team session\]\([^\r\n)]*\)\s*)+$/u, "")
    .replace(
      /(?:^|\n\n)## Worked on by\n\n(?:- @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\n)*- @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?=\n\n|$)/gu,
      "",
    )
    .trimEnd();
  const prepared = await prepareGitCoauthorAttribution({
    agentId: row.agent_id,
    config,
    excludeAccountId: params.accountId,
    host: params.host,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    storePath: params.storePath,
  });
  const attributionEnabled = await preparePrAttribution({
    requesterProfileId: params.requesterProfileId,
    sessionKey: row.session_key,
    incognito: initialEntry?.incognito,
  });
  params.assertCurrent();
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
      const currentEntry = params.readCurrentEntry();
      const currentShare = resolveSessionPublicShare(currentEntry);
      const participants = credit ? `\n\n## Worked on by\n\n${credit}` : "";
      // A late revoke only removes optional disclosure; a new grant cannot add it to this request.
      const footer =
        sessionUrl &&
        currentShare?.id === initialShare?.id &&
        currentShare?.sessionId === initialShare?.sessionId
          ? `\n\n---\n[View the OpenClaw team session](${sessionUrl})`
          : "";
      const body = appendPrAttribution(
        `${description}${participants}\n\n<!-- openclaw-publication:${row.request_id} -->`,
        attributionEnabled() && !currentEntry?.incognito,
      );
      return `${body}${footer}`;
    },
  };
}
