import { describe, expect, it, vi } from "vitest";
import "../test-helpers/fast-core-tools.js";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../claude-agent-sdk/sdk.js", () => ({
  loadClaudeAgentSdk: async () => {
    throw new Error("mock: sdk unavailable");
  },
}));

import { createClawdbrainTools } from "../clawdbrain-tools.js";

describe("coding_task tool", () => {
  it("is not registered by default", () => {
    const tool = createClawdbrainTools().find((candidate) => candidate.name === "coding_task");
    expect(tool).toBeUndefined();
  });

  it("registers when enabled and fails gracefully when SDK is missing", async () => {
    const cfg: OpenClawConfig = {
      tools: { codingTask: { enabled: true } },
    };
    const tool = createClawdbrainTools({ config: cfg }).find(
      (candidate) => candidate.name === "coding_task",
    );
    expect(tool).toBeTruthy();
    if (!tool) {
      return;
    }

    const result = await tool.execute("call1", { task: "Plan how to refactor foo" });
    expect(result.details).toMatchObject({
      status: "error",
      error: "sdk_unavailable",
    });
  });
});
