import { formatGitHubPublicationContent } from "../../extensions/github-repositories/publication-content-api.js";
import { currentGitHubPublicationConfig } from "../../extensions/github-repositories/runtime-api.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { prepareRepositoryPublicationContentFacts } from "./github-publication-content.js";

/** Enterprise identity proof composes canonical host facts with the real plugin formatter. */
export async function prepareGitHubPublicationContent(params: {
  row: Pick<
    GitHubPublicationExecutionRow,
    "request_id" | "agent_id" | "session_id" | "session_key" | "branch" | "title"
  >;
  storePath: string;
  accountId: number;
  host: string;
  assertCurrent: () => void;
  // Reuse the retained publication owner; do not open another session read.
  readCurrentEntry: () => InternalSessionEntry | undefined;
  description: string;
}) {
  const { row } = params;
  const facts = await prepareRepositoryPublicationContentFacts({
    session: { agentId: row.agent_id, sessionKey: row.session_key, sessionId: row.session_id },
    storePath: params.storePath,
    config: currentGitHubPublicationConfig(),
    accountId: params.accountId,
    host: params.host,
    readCurrentEntry: params.readCurrentEntry,
    assertCurrent: params.assertCurrent,
  });
  const { assertCurrent: assertAction, ...content } = formatGitHubPublicationContent({
    requestId: row.request_id,
    title: row.title ?? undefined,
    branch: row.branch,
    description: params.description,
    facts,
  });
  return { ...content, assertAction };
}
