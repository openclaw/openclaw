export type GitHubItemMatch = readonly [
  owner: string,
  repo: string,
  issue: string | undefined,
  pull: string | undefined,
];

export function isGitHubHost(hostname: string): boolean {
  return /^(?:www\.)?github\.com\.?$/i.test(hostname);
}

export function matchGitHubItemPath(url: URL): GitHubItemMatch | null {
  // Match the actual pathname, never a resource embedded in an auth redirect or
  // an arbitrary suffix. These PR subviews still identify the same resource.
  const match =
    /^\/([^/]+)\/([^/]+)\/(?:issues\/([1-9]\d{0,9})|pull\/([1-9]\d{0,9})(?:\/(?:files|checks|commits(?:\/[a-fA-F\d]{7,40})?))?)\/?$/u.exec(
      url.pathname,
    );
  if (!match) {
    return null;
  }
  try {
    const owner = decodeURIComponent(match[1]!);
    const repo = decodeURIComponent(match[2]!);
    if (
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) ||
      !/^[a-z\d._-]{1,100}$/i.test(repo) ||
      /^\.{1,2}$|\.(?:git|atom)$/i.test(repo)
    ) {
      return null;
    }
    return [owner, repo, match[3], match[4]];
  } catch {
    return null;
  }
}

/** Match a prepared URL without pulling Markdown label formatting into startup. */
export function matchGitHubItemUrl(url: URL): GitHubItemMatch | null {
  return url.href.startsWith("https://github.com/") ? matchGitHubItemPath(url) : null;
}
