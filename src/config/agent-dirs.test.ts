import { describe, expect, it } from "vitest";
import { formatDuplicateAgentDirError, type DuplicateAgentDir } from "./agent-dirs.js";

describe("formatDuplicateAgentDirError", () => {
  it("formats a single conflict", () => {
    const dups: DuplicateAgentDir[] = [
      { agentDir: "/home/user/.openclaw/agents/shared", agentIds: ["agent-a", "agent-b"] },
    ];
    const result = formatDuplicateAgentDirError(dups);
    expect(result).toContain("Duplicate agentDir detected");
    expect(result).toContain("/home/user/.openclaw/agents/shared");
    expect(result).toContain('"agent-a"');
    expect(result).toContain('"agent-b"');
  });

  it("formats multiple conflicts", () => {
    const dups: DuplicateAgentDir[] = [
      { agentDir: "/path/a", agentIds: ["x", "y"] },
      { agentDir: "/path/b", agentIds: ["p", "q", "r"] },
    ];
    const result = formatDuplicateAgentDirError(dups);
    expect(result).toContain("/path/a");
    expect(result).toContain("/path/b");
    expect(result).toContain('"r"');
  });

  it("includes fix suggestion", () => {
    const dups: DuplicateAgentDir[] = [{ agentDir: "/dir", agentIds: ["a", "b"] }];
    const result = formatDuplicateAgentDirError(dups);
    expect(result).toContain("Fix:");
    expect(result).toContain("auth-profiles.json");
  });

  it("handles empty array", () => {
    const result = formatDuplicateAgentDirError([]);
    expect(result).toContain("Duplicate agentDir detected");
    expect(result).not.toContain("- /");
  });
});
