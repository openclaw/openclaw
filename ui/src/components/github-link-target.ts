const GITHUB_URL_PREFIX = "https://github.com/";

type GitHubItemTarget = {
  kind: "issue" | "pull";
  number: number;
  owner: string;
  repo: string;
};

export type GitHubLinkTarget = GitHubItemTarget & {
  href: string;
};

export function decodeGitHubPathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && decoded !== "." && decoded !== ".." ? decoded : null;
  } catch {
    return null;
  }
}

export function parseGitHubItemPath(url: URL): GitHubItemTarget | null {
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = decodeGitHubPathSegment(segments[0] ?? "");
  const repo = decodeGitHubPathSegment(segments[1] ?? "");
  const surface = segments[2];
  const numberText = segments[3] ?? "";
  if (!owner || !repo || !/^[1-9]\d{0,9}$/.test(numberText)) {
    return null;
  }
  const kind = surface === "issues" ? "issue" : surface === "pull" ? "pull" : null;
  return kind ? { kind, number: Number(numberText), owner, repo } : null;
}

export function parseGitHubLinkTarget(href: string): GitHubLinkTarget | null {
  let url: URL;
  try {
    // Anchors resolve relative links; the stream scanner supplies absolute URLs.
    url = new URL(href);
  } catch {
    return null;
  }
  // Match the parsed URL so credentials, ports, and lookalike hosts cannot pass.
  if (!url.href.startsWith(GITHUB_URL_PREFIX)) {
    return null;
  }
  const target = parseGitHubItemPath(url);
  return target ? { ...target, href: url.href } : null;
}
