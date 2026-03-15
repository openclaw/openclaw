import { describe, expect, it } from "vitest";
import { appendHeartbeatWorkspacePathHint } from "./heartbeat-runner.js";

describe("appendHeartbeatWorkspacePathHint — user-custom prompt guard", () => {
  const workspaceDir = "/home/user/.openclaw/workspace";

  it("does not modify a user-configured custom prompt even when it mentions HEARTBEAT.md", () => {
    const customPrompt =
      "You are Ash. When you receive a heartbeat, read HEARTBEAT.md from my workspace and execute.";
    const result = appendHeartbeatWorkspacePathHint(customPrompt, workspaceDir, true);
    expect(result).toBe(customPrompt);
  });

  it("appends the workspace hint to the default prompt when no custom prompt is set", () => {
    const defaultPrompt =
      "HEARTBEAT TRIGGER. Read HEARTBEAT.md. Execute the highest-priority task.";
    const result = appendHeartbeatWorkspacePathHint(defaultPrompt, workspaceDir, false);
    expect(result).toContain("use workspace file");
    expect(result).toContain("HEARTBEAT.md");
    expect(result).toContain(workspaceDir);
  });

  it("returns the prompt unchanged when it does not reference heartbeat.md (default or custom)", () => {
    const unrelatedPrompt = "Run the daily report and post to Slack.";
    expect(appendHeartbeatWorkspacePathHint(unrelatedPrompt, workspaceDir, false)).toBe(
      unrelatedPrompt,
    );
    expect(appendHeartbeatWorkspacePathHint(unrelatedPrompt, workspaceDir, true)).toBe(
      unrelatedPrompt,
    );
  });

  it("does not duplicate the hint when already present", () => {
    const hint = `When reading HEARTBEAT.md, use workspace file ${workspaceDir}/HEARTBEAT.md (exact case). Do not read docs/heartbeat.md.`;
    const promptWithHint = `HEARTBEAT TRIGGER. Read HEARTBEAT.md.\n${hint}`;
    const result = appendHeartbeatWorkspacePathHint(promptWithHint, workspaceDir, false);
    expect(result.split("use workspace file").length).toBe(2); // only one occurrence
  });
});
