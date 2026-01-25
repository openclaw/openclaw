import { describe, expect, it } from "vitest";

import "../test-helpers/fast-core-tools.js";
import { createClawdbotTools } from "../clawdbot-tools.js";
import type { ClawdbotConfig } from "../../config/config.js";

describe("coding_task tool", () => {
  it("is not registered by default", () => {
    const tool = createClawdbotTools().find((candidate) => candidate.name === "coding_task");
    expect(tool).toBeUndefined();
  });

  it("registers when enabled and fails gracefully when SDK is missing", async () => {
    const cfg: ClawdbotConfig = {
      tools: { codingTask: { enabled: true } },
    };
    const tool = createClawdbotTools({ config: cfg }).find(
      (candidate) => candidate.name === "coding_task",
    );
    expect(tool).toBeTruthy();
    if (!tool) return;

    const result = await tool.execute("call1", { task: "Plan how to refactor foo" });
    expect(result.details).toMatchObject({
      status: "error",
      error: "sdk_unavailable",
    });
  });
});
