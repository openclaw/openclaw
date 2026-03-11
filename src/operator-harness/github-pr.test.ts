import { describe, expect, it } from "vitest";
import { buildPullRequestHeadRefName } from "./github-pr.js";

describe("buildPullRequestHeadRefName", () => {
  it("uses the bare branch name when pushing to the base repo", () => {
    expect(
      buildPullRequestHeadRefName({
        branchName: "codex/end-7",
        repoUrl: "https://github.com/openclaw/openclaw",
        pushRepoUrl: "https://github.com/openclaw/openclaw",
      }),
    ).toBe("codex/end-7");
  });

  it("uses owner-qualified heads when pushing from a fork", () => {
    expect(
      buildPullRequestHeadRefName({
        branchName: "codex/end-7",
        repoUrl: "https://github.com/openclaw/openclaw",
        pushRepoUrl: "https://github.com/ec-seeq/openclaw",
      }),
    ).toBe("ec-seeq:codex/end-7");
  });
});
