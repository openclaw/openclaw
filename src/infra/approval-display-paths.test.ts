// Covers path shortening for approval display text.
import { describe, expect, it } from "vitest";
import { formatApprovalDisplayPath } from "./approval-display-paths.js";

describe("approval display paths", () => {
  it.each([
    ["/home/alice", "~"],
    ["/home/alice/.ssh/id_rsa", "~/.ssh/id_rsa"],
    ["/Users/alice/Documents/project", "~/Documents/project"],
    ["c:/users/bob/project", "~/project"],
    ["C:\\Users\\alice\\.ssh\\id_rsa", "~/.ssh/id_rsa"],
    ["/workspace/project", "/workspace/project"],
    ["C:\\workspace\\project", "C:\\workspace\\project"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatApprovalDisplayPath(input)).toBe(expected);
  });

  it.each(["/Users/alice/../Library", "C:\\Users\\alice\\.\\project"])(
    "does not compact relative-segment path %s",
    (input) => {
      expect(formatApprovalDisplayPath(input)).toBe(input);
    },
  );
});
