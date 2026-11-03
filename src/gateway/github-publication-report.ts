import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/index.js";

const GITHUB_PUBLICATION_RESPONSE_PREFIX = "github-publication:";

function formatGitHubPublicationResult(result: SessionGitHubPublicationResult): string {
  const publisher = result.publisher;
  const source =
    publisher?.source === "personal"
      ? "My GitHub"
      : publisher?.source === "agent-override"
        ? "Agent override"
        : "System";
  const acting = publisher ? ` Using @${publisher.login} (${source}).` : "";
  switch (result.status) {
    case "published":
      return `Published ${result.repository} branch ${result.branch}: ${result.url}${acting}`;
    case "failed":
      return `${result.message} ${result.nextAction}${acting}`;
    case "publishing":
    case "requested":
    case "needs_confirmation":
      return `${result.message}${acting}`;
  }
  return result satisfies never;
}

/** A stable response id preserves transcript deduplication across report retries and restart. */
export function formatGitHubPublicationTranscript(result: SessionGitHubPublicationResult) {
  return {
    text: formatGitHubPublicationResult(result),
    responseId: `${GITHUB_PUBLICATION_RESPONSE_PREFIX}${result.requestId}`,
  };
}
