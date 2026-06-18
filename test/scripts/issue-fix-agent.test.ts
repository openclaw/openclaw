// Issue Fix Agent tests cover local maintainer automation behavior.
import { describe, expect, it } from "vitest";
import {
  parseIssueFixAgentArgs,
  renderIssueFixAgentUsage,
} from "../../scripts/issue-fix-agent-main.ts";

describe("issue-fix-agent args", () => {
  it("parses scan without write flags", () => {
    expect(parseIssueFixAgentArgs(["scan"])).toStrictEqual({
      command: "scan",
      execute: false,
      pushPr: false,
      yes: false,
    });
  });

  it("requires --execute before --push-pr", () => {
    expect(() => parseIssueFixAgentArgs(["run", "--push-pr"])).toThrow(
      "--push-pr requires --execute",
    );
  });

  it("parses monitor with a PR number", () => {
    expect(parseIssueFixAgentArgs(["monitor", "12345"])).toStrictEqual({
      command: "monitor",
      execute: false,
      prNumber: 12345,
      pushPr: false,
      yes: false,
    });
  });

  it("renders usage with every first-version command", () => {
    expect(renderIssueFixAgentUsage()).toContain("scripts/issue-fix-agent scan");
    expect(renderIssueFixAgentUsage()).toContain("scripts/issue-fix-agent gc --dry-run");
  });
});
