import {
  matchGitHubItemPath,
  matchGitHubItemUrl,
  type GitHubItemMatch,
} from "./github-link-eligibility.ts";

type GitHubItemTarget = { kind: "issue" | "pull"; owner: string; repo: string; number: number };
export function formatGitHubItemReference(
  item: Pick<GitHubItemTarget, "owner" | "repo" | "number">,
): string {
  return `${item.owner}/${item.repo}#${item.number}`;
}

export function decodeGitHubPathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && decoded !== "." && decoded !== ".." ? decoded : null;
  } catch {
    return null;
  }
}

function itemTarget([owner, repo, issue, pull]: GitHubItemMatch): GitHubItemTarget {
  return { kind: issue ? "issue" : "pull", number: Number(issue ?? pull), owner, repo };
}

export function parseGitHubItemPath(url: URL): GitHubItemTarget | null {
  const match = matchGitHubItemPath(url);
  return match ? itemTarget(match) : null;
}

export function parseGitHubLinkTarget(href: string): (GitHubItemTarget & { href: string }) | null {
  // Anchors resolve relative links; the stream scanner supplies absolute URLs.
  const url = URL.parse(href);
  const match = url ? matchGitHubItemUrl(url) : null;
  return match && url ? { ...itemTarget(match), href: url.href } : null;
}
