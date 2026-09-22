export type GitHubItemMatch = readonly [
  owner: string,
  repo: string,
  issue: string | undefined,
  pull: string | undefined,
];

export function isGitHubHost(hostname: string): boolean {
  return /^(?:www\.)?github\.com\.?$/i.test(hostname);
}

function decodeRepository(ownerPath: string, repoPath: string): readonly [string, string] | null {
  try {
    const owner = decodeURIComponent(ownerPath);
    const repo = decodeURIComponent(repoPath);
    return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) &&
      /^[a-z\d._-]{1,100}$/i.test(repo) &&
      !/^\.{1,2}$|\.(?:git|atom)$/i.test(repo)
      ? [owner, repo]
      : null;
  } catch {
    return null;
  }
}

/** GitHub's account, dashboard, and auth routes can also have two path segments. */
export function isGitHubPublicPageUrl(url: URL): boolean {
  if (!url.href.startsWith("https://github.com/")) {
    return false;
  }
  const match = /^\/([^/]+)\/([^/]+)\/?$/u.exec(url.pathname);
  const repository = match ? decodeRepository(match[1]!, match[2]!) : null;
  return Boolean(
    repository &&
    !/^(?:account|accounts|apps|auth|codespaces|copilot|dashboard|discussions|email|emails|enterprises|github-copilot|issues|join|login|logout|marketplace|new|notifications|oauth|orgs|organizations|projects|pulls|repositories|session|sessions|settings|signup|sponsors|stars|two-factor|user|users|verify|watching)$/i.test(
      repository[0],
    ),
  );
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
  const repository = decodeRepository(match[1]!, match[2]!);
  return repository ? [...repository, match[3], match[4]] : null;
}

/** Match a prepared URL without pulling Markdown label formatting into startup. */
export function matchGitHubItemUrl(url: URL): GitHubItemMatch | null {
  return url.href.startsWith("https://github.com/") ? matchGitHubItemPath(url) : null;
}
