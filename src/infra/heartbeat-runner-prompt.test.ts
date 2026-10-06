// Covers heartbeat run prompt assembly for scheduled heartbeat tasks.
import { describe, expect, it } from "vitest";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatPreflight, resolveHeartbeatRunPrompt } from "./heartbeat-runner-prompt.js";

const cfg: OpenClawConfig = { agents: { list: [{ id: "main" }] } };
const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });

describe("resolveHeartbeatRunPrompt scheduled tasks", () => {
  it("includes the tool-absent fallback for response-tool scheduled-task prompts", async () => {
    const preflight = await resolveHeartbeatPreflight({
      cfg,
      agentId: "main",
      sessionKey,
      scheduledTasks: [{ jobId: "job-1", name: "nightly-check", prompt: "Check the backups." }],
    });

    const resolution = resolveHeartbeatRunPrompt({
      cfg,
      preflight,
      canRelayToUser: true,
      startedAt: Date.parse("2026-09-16T12:00:00.000Z"),
      scheduledTasks: [{ jobId: "job-1", name: "nightly-check", prompt: "Check the backups." }],
      useHeartbeatResponseTool: true,
    });

    expect(resolution.usesHeartbeatResponseTool).toBe(true);
    expect(resolution.prompt).toContain("Run the following periodic tasks");
    expect(resolution.prompt).toContain("Check the backups.");
    expect(resolution.prompt).toContain("heartbeat_respond");
    expect(resolution.prompt).toContain(
      "If the heartbeat_respond tool is not available in this run",
    );
  });

  it("keeps silent-reply completion when response-tool mode is off", async () => {
    const preflight = await resolveHeartbeatPreflight({
      cfg,
      agentId: "main",
      sessionKey,
      scheduledTasks: [{ jobId: "job-1", name: "nightly-check", prompt: "Check the backups." }],
    });

    const resolution = resolveHeartbeatRunPrompt({
      cfg,
      preflight,
      canRelayToUser: true,
      startedAt: Date.parse("2026-09-16T12:00:00.000Z"),
      scheduledTasks: [{ jobId: "job-1", name: "nightly-check", prompt: "Check the backups." }],
      useHeartbeatResponseTool: false,
    });

    expect(resolution.prompt).toContain("After completing all due tasks, reply NO_REPLY.");
    expect(resolution.prompt).not.toContain("If the heartbeat_respond tool is not available");
  });
});
