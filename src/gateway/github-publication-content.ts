import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { prepareGitCoauthorAttribution } from "../agents/git-coauthor-attribution.js";
import { appendPrAttribution, preparePrAttribution } from "../agents/pr-attribution.js";
import { resolveControlUiPublicSessionUrl } from "../config/control-ui-link-base.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { sanitizeChatDisplayText } from "../shared/text/chat-display.js";
import { escapeMarkdownText } from "../shared/text/escape-markdown.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { getResidentUserProfileDisplay } from "../state/user-profile-list.js";
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import { GitHubPublicationCreditChangedError } from "./github-publication-failure.js";
import {
  appendGitHubPublicationMessage,
  type createGitHubPublicationCommandRunner,
} from "./github-publication-git-transport.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";

type BranchHistory = {
  cwd: string;
  base: string;
  head: string;
  run: ReturnType<typeof createGitHubPublicationCommandRunner>["run"];
};

/**
 * The oldest commit a branch adds to its base, as `gh pr create --fill-first` reads it,
 * within the bounds a request's own title and body must meet.
 * Best effort: a default title and body never fail a publication.
 */
async function readFirstBranchCommit({ cwd, base, head, run }: BranchHistory) {
  // Merged-in history and earlier publication commits describe other work.
  const commits = await run(
    [
      "git",
      "rev-list",
      "--reverse",
      "--first-parent",
      "--no-merges",
      "--invert-grep",
      "--grep=^OpenClaw-Publication: ",
      `${base}..${head}`,
    ],
    { cwd },
  );
  const commit = commits.code === 0 ? commits.stdout.toString("utf8").split("\n", 1)[0] : "";
  if (!commit) {
    return undefined;
  }
  const shown = await run(
    ["git", "show", "-s", "--no-show-signature", "--format=%s%x00%b%x00%(trailers)", commit],
    { cwd },
  );
  if (shown.code !== 0) {
    return undefined;
  }
  const [subject = "", message = "", trailerBlock = ""] = shown.stdout.toString("utf8").split("\0");
  const body = message.trimEnd();
  const trailers = trailerBlock.trimEnd();
  return {
    title: truncateUtf16Safe(subject.trim(), 256).trimEnd(),
    // Credit and sign-off trailers belong to the commit; the pull request states its own credit.
    description: truncateUtf16Safe(
      trailers && body.endsWith(trailers) ? body.slice(0, -trailers.length) : body,
      8 * 1024,
    ).trim(),
  };
}

export async function prepareGitHubPublicationContent(params: {
  row: Pick<
    GitHubPublicationExecutionRow,
    "request_id" | "agent_id" | "session_id" | "session_key" | "branch" | "title" | "body"
  >;
  requesterProfileId?: string;
  // The admitted participant's display name, never the creator or publisher identity.
  participantDisplayName?: string;
  storePath: string;
  accountId: number;
  host: string;
  assertCurrent: () => void;
  // Reuse the retained publication owner; do not open another session read.
  readCurrentEntry: () => InternalSessionEntry | undefined;
  defaultDescription: string;
  /** Local history of the published branch; a repository checkpoint has none to read. */
  history?: BranchHistory;
  /** An existing pull request keeps its title and body, so it needs no defaults. */
  existingPullRequest?: string;
}) {
  const { row } = params;
  const firstCommit =
    params.history && !params.existingPullRequest && !(row.title?.trim() && row.body?.trim())
      ? await readFirstBranchCommit(params.history)
      : undefined;
  const config = currentGitHubPublicationConfig();
  const initialEntry = params.readCurrentEntry();
  const initialShare = resolveSessionPublicShare(initialEntry);
  const sessionUrl = resolveControlUiPublicSessionUrl(config, {
    sessionKey: row.session_key,
    sessionId: row.session_id,
    agentId: row.agent_id,
    entry: initialEntry,
  });
  const description = (row.body?.trim() || firstCommit?.description || params.defaultDescription)
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

  const participantName = escapeMarkdownText(
    sanitizeChatDisplayText(params.participantDisplayName?.replace(/\s+/gu, " ").trim() ?? ""),
  );
  const requestedBy = participantName ? `\n\nRequested by ${participantName} via OpenClaw` : "";
  const trailers = prepared.attribution?.trailers ?? [];
  const credit = prepared.attribution?.logins.map((login) => `- @${login}`).join("\n");
  return {
    title,
    trailers,
    commitMessage: `${appendGitHubPublicationMessage(
      credit ? `${commitTitle}\n\nWorked on by:\n${credit}` : commitTitle,
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
        `${description}${requestedBy}${participants}\n\n<!-- openclaw-publication:${row.request_id} -->`,
        attributionEnabled() && !currentEntry?.incognito,
      );
      return `${body}${footer}`;
    },
  };
}

/** Shared attribution names the retained participant, never the session creator or API writer. */
export function publicationParticipantDisplayName(
  requester?: GitHubPublicationRequesterPolicyV2,
): string | undefined {
  const ceiling = requester?.snapshot.participation?.ceiling;
  return ceiling
    ? getResidentUserProfileDisplay(ceiling.profileId).displayName || "Participant"
    : undefined;
}
