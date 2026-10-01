import { describe, expect, it } from "vitest";
import { matchGitHubItemUrl } from "./github-link-eligibility.ts";
import { parseGitHubLinkTarget } from "./github-link-target.ts";

describe("GitHub issue and pull-request preview targets", () => {
  it.each([
    ["https://github.com/acme/project/issues/42", "issue"],
    ["https://github.com/acme/project/issues/42/#issuecomment-7", "issue"],
    ["https://github.com/acme/project/pull/42", "pull"],
    ["https://github.com/acme/project/pull/42/files#diff-example", "pull"],
    ["https://github.com/acme/project/pull/42/commits", "pull"],
    ["https://github.com/acme/project/pull/42/checks", "pull"],
    ["https://github.com/acme/project/pull/42?tab=files#discussion_r7", "pull"],
    ["HTTPS://GITHUB.COM:443/acme/project/pull/42", "pull"],
    ["https://github.com/%61cme/project/pull/42", "pull"],
  ])("preserves resource identity and destination for %s", (href, kind) => {
    expect(matchGitHubItemUrl(new URL(href))).not.toBeNull();
    expect(parseGitHubLinkTarget(href)).toEqual({
      kind,
      owner: "acme",
      repo: "project",
      number: 42,
      href: new URL(href).href,
    });
  });

  it.each([
    "https://github.com/login",
    "https://github.com/login?return_to=https://github.com/acme/project/pull/42",
    "https://github.com/login?return_to=%2Facme%2Fproject%2Fissues%2F42",
    "https://github.com/login/oauth/authorize?client_id=example-client",
    "https://github.com/session",
    "https://github.com/settings/connections/applications/example",
    "https://github.com/",
    "https://github.com/acme",
    "https://github.com/acme/project",
    "https://github.com/acme/project/commit/abcdef0123456789",
    "https://example.com/?redirect=https://github.com/acme/project/pull/42",
    "https://example.com/https://github.com/acme/project/pull/42",
    "https://github.com.example.com/acme/project/pull/42",
    "https://example@github.com/acme/project/pull/42",
    "http://github.com/acme/project/pull/42",
    "https://github.com:8443/acme/project/pull/42",
    "https://github.com/acme/project/pull/0",
    "https://github.com/acme/project/p%75ll/42",
    "https://github.com/acme/project/pull/%34%32",
    "https://github.com/" + "a".repeat(40) + "/project/pull/42",
    "https://github.com/acme/" + "r".repeat(101) + "/pull/42",
    "https://github.com/acme/project.git/pull/42",
    "https://github.com/acme/project.atom/pull/42",
    "https://github.com/acme/project/pull/42/login",
    "https://github.com/acme/project/issues/42/files",
    "https://github.com/acme/project/pull/42/files/extra",
    "https://github.com//acme/project/pull/42",
    "https://github.com/acme%2Fother/project/pull/42",
    "https://github.com/%20acme/project/pull/42",
    "https://github.com/acme/project%2Fother/pull/42",
  ])("does not infer an issue or PR from %s", (href) => {
    expect(matchGitHubItemUrl(new URL(href))).toBeNull();
    expect(parseGitHubLinkTarget(href)).toBeNull();
  });
});
