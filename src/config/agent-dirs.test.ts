import { describe, expect, it } from "vitest";
import { findDuplicateAgentDirs } from "./agent-dirs.js";

describe("findDuplicateAgentDirs", () => {
  it("returns empty array when no duplicates", () => {
    const config = {
      agentDirs: ["/path/a", "/path/b"],
      agents: []
    };
    expect(findDuplicateAgentDirs(config)).toEqual([]);
  });
});
