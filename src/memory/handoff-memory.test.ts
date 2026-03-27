import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentEndLifecycle } from "../agents/pi-embedded-runner/run/attempt.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import {
  backfillBeforeResetHandoffMemory,
  backfillSessionEndHandoffMemory,
} from "./handoff-memory.js";

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: () => [],
}));

function extractJsonBlock(raw: string): Record<string, unknown> {
  const match = raw.match(/```json\n([\s\S]*?)\n```/);
  expect(match?.[1]).toBeTruthy();
  return JSON.parse(match?.[1] ?? "{}");
}

async function readLatestHandoffRecord(workspaceDir: string): Promise<Record<string, unknown>> {
  const latestPath = path.join(workspaceDir, "memory", "handoff-latest.md");
  return extractJsonBlock(await fs.readFile(latestPath, "utf8"));
}

async function countHandoffSnapshots(workspaceDir: string): Promise<number> {
  const handoffRoot = path.join(workspaceDir, "memory", "handoffs");
  try {
    const dates = await fs.readdir(handoffRoot);
    let total = 0;
    for (const date of dates) {
      const entries = await fs.readdir(path.join(handoffRoot, date));
      total += entries.length;
    }
    return total;
  } catch {
    return 0;
  }
}

async function cleanupTempPaths(tempPaths: string[]) {
  while (tempPaths.length > 0) {
    const target = tempPaths.pop();
    if (target) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
}

describe("handoff memory", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await cleanupTempPaths(tempPaths);
  });

  // Keep one direct lifecycle seam test here so the CI guardrail always has a stable trigger file.
  it("writes handoff-latest and an immutable handoff snapshot from the agent_end lifecycle seam", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-workspace-"));
    tempPaths.push(workspaceDir);

    const sessionFile = path.join(workspaceDir, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    const hookRunner = {
      hasHooks: vi.fn((hookName: "agent_end") => hookName === "agent_end"),
      runAgentEnd: vi.fn(async () => undefined),
    };
    const messagesSnapshot = [
      {
        role: "user",
        content: "Review the Memory HQ handoff.",
        timestamp: Date.now() - 500,
      } as AgentMessage,
      {
        role: "assistant",
        content: "The latest stable state is ready.",
        timestamp: Date.now(),
      } as AgentMessage,
    ];

    await runAgentEndLifecycle({
      workspaceDir,
      agentId: "voltaris-v2",
      sessionId: "embedded-session",
      sessionKey: "agent:voltaris-v2:session:handoff-test",
      sessionFile,
      messagesSnapshot,
      success: true,
      durationMs: 4321,
      trigger: "manual",
      messageProvider: "webchat",
      messageChannel: "webchat",
      hookRunner,
    });
    await vi.waitFor(() => expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1));

    const latestPath = path.join(workspaceDir, "memory", "handoff-latest.md");
    const handoffRoot = path.join(workspaceDir, "memory", "handoffs");
    const handoffDates = await fs.readdir(handoffRoot);
    expect(handoffDates).toHaveLength(1);

    const snapshotDir = path.join(handoffRoot, handoffDates[0] ?? "");
    const snapshotFiles = await fs.readdir(snapshotDir);
    expect(snapshotFiles).toHaveLength(1);

    const latestRaw = await fs.readFile(latestPath, "utf8");
    const latestRecord = extractJsonBlock(latestRaw);

    expect(latestRecord).toMatchObject({
      schema: "openclaw.handoff-memory.v1",
      compartment: "handoff_memory",
      agentId: "voltaris-v2",
      sessionId: "embedded-session",
      sessionKey: "agent:voltaris-v2:session:handoff-test",
      source: "agent_end",
      runStatus: "ok",
      trigger: "manual",
      messageCount: 2,
    });
    expect(latestRaw).toContain("# Handoff Snapshot");
    expect(latestRaw).toContain("## Stable State");
    expect(latestRaw).toContain("## Key Evidence Pointers");
    expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
      {
        messages: messagesSnapshot,
        success: true,
        error: undefined,
        durationMs: 4321,
      },
      expect.objectContaining({
        agentId: "voltaris-v2",
        sessionId: "embedded-session",
        sessionKey: "agent:voltaris-v2:session:handoff-test",
        workspaceDir,
        messageProvider: "webchat",
      }),
    );
  });

  it("skips before_reset fallback when a fresh agent_end handoff already exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-workspace-"));
    tempPaths.push(workspaceDir);

    const sessionFile = path.join(workspaceDir, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");

    await runAgentEndLifecycle({
      workspaceDir,
      agentId: "voltaris-v2",
      sessionId: "embedded-session",
      sessionKey: "agent:voltaris-v2:session:handoff-test",
      sessionFile,
      messagesSnapshot: [
        {
          role: "assistant",
          content: "Fresh agent_end handoff.",
          timestamp: Date.now(),
        } as AgentMessage,
      ],
      success: true,
      durationMs: 123,
    });

    const result = await backfillBeforeResetHandoffMemory({
      workspaceDir,
      agentId: "voltaris-v2",
      sessionId: "embedded-session",
      sessionKey: "agent:voltaris-v2:session:handoff-test",
      sessionFile,
      action: "reset",
      messages: [],
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "fresh-agent-end-snapshot",
    });
  });

  it("uses transcriptMtimeMs to upgrade a stale before_reset handoff even when the transcript path disappears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-27T20:00:00.000Z"));

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-workspace-"));
    tempPaths.push(workspaceDir);

    const sessionFile = path.join(workspaceDir, "session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    await backfillBeforeResetHandoffMemory({
      workspaceDir,
      agentId: "voltaris-v2",
      sessionId: "embedded-session",
      sessionKey: "agent:voltaris-v2:session:handoff-test",
      sessionFile,
      action: "reset",
      messages: [
        {
          role: "assistant",
          content: "Fresh before_reset handoff.",
          timestamp: Date.now(),
        } as AgentMessage,
      ],
    });

    const latestBefore = await readLatestHandoffRecord(workspaceDir);
    expect(latestBefore).toMatchObject({ source: "before_reset" });
    expect(await countHandoffSnapshots(workspaceDir)).toBe(1);

    await fs.rm(sessionFile, { force: true });
    vi.setSystemTime(new Date("2026-03-27T20:05:00.000Z"));

    const result = await backfillSessionEndHandoffMemory({
      workspaceDir,
      agentId: "voltaris-v2",
      sessionId: "embedded-session",
      sessionKey: "agent:voltaris-v2:session:handoff-test",
      sessionFile,
      transcriptMtimeMs: Date.parse("2026-03-27T20:04:00.000Z"),
      messages: [
        {
          role: "assistant",
          content: "The session rotated after the stale pre-reset handoff.",
          timestamp: Date.now(),
        } as AgentMessage,
      ],
    });

    expect(result).toMatchObject({ status: "written" });
    expect(await countHandoffSnapshots(workspaceDir)).toBe(2);
    expect(await readLatestHandoffRecord(workspaceDir)).toMatchObject({
      source: "session_end",
      runStatus: "unknown",
      trigger: "session_end",
    });
  });
});
