import { describe, expect, it } from "vitest";
import { parseGitHubLinkTarget } from "./github-link-target.ts";

describe("GitHub issue and pull-request preview targets", () => {
  it("classifies Enterprise items only with verified host context", () => {
    const href = "https://microsoft.ghe.com/bic/lobster/pull/17420";
    expect(parseGitHubLinkTarget(href)).toBeNull();
    expect(parseGitHubLinkTarget(href, ["other.ghe.com"])).toBeNull();
    expect(parseGitHubLinkTarget(href, ["microsoft.ghe.com"])).toEqual({
      kind: "pull",
      owner: "bic",
      repo: "lobster",
      number: 17420,
      href,
    });
    expect(
      parseGitHubLinkTarget("https://user@microsoft.ghe.com/bic/lobster/pull/17420", [
        "microsoft.ghe.com",
      ]),
    ).toBeNull();
    expect(
      parseGitHubLinkTarget("https://microsoft.ghe.com:8443/bic/lobster/pull/17420", [
        "microsoft.ghe.com",
      ]),
    ).toBeNull();
  });

  it.each([
    ["https://github.com/acme/project/issues/42/#issuecomment-7", "issue"],
    ["https://github.com/acme/project/pull/42", "pull"],
    ["https://github.com/acme/project/pull/42/files#diff-example", "pull"],
    ["https://github.com/acme/project/pull/42/commits", "pull"],
    ["https://github.com/acme/project/pull/42/checks", "pull"],
    ["https://github.com/acme/project/pull/42?tab=files#discussion_r7", "pull"],
    ["HTTPS://GITHUB.COM:443/acme/project/pull/42", "pull"],
    ["https://github.com/%61cme/project/pull/42", "pull"],
  ])("preserves resource identity and destination for %s", (href, kind) => {
    expect(parseGitHubLinkTarget(href)).toEqual({
      kind,
      owner: "acme",
      repo: "project",
      number: 42,
      href: new URL(href).href,
    });
  });

  it.each([
    "https://github.com/login?return_to=https://github.com/acme/project/pull/42",
    "https://github.com/acme/project",
    "https://github.com/acme/project/commit/abcdef0123456789",
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
    "https://github.com/acme/project/issues/42/files",
    "https://github.com/acme/project/pull/42/files/extra",
    "https://github.com/acme%2Fother/project/pull/42",
    "https://github.com/acme/project%2Fother/pull/42",
  ])("does not infer an issue or PR from %s", (href) => {
    expect(parseGitHubLinkTarget(href)).toBeNull();
  });
});
