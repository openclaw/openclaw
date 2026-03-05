import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSelfImproveConversationHistorySummary,
  buildSelfImproveRunbookText,
  isSelfImproveCronRun,
} from "./self-improve.js";

const TEMP_DIR_PREFIX = "openclaw-self-improve-test-";
const tempDirs: string[] = [];

async function withTempSessionsDir<T>(fn: (sessionsDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  tempDirs.push(dir);
  return fn(dir);
}

async function writeTranscript(
  sessionsDir: string,
  fileName: string,
  lines: Array<Record<string, unknown>>,
) {
  const fullPath = path.join(sessionsDir, fileName);
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await fs.writeFile(fullPath, body, "utf-8");
  await fs.utimes(fullPath, new Date(), new Date());
}

describe("cron self-improve helpers", () => {
  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("detects self-improve cron intent from job metadata or message", () => {
    expect(
      isSelfImproveCronRun({
        jobId: "cron-self-improve",
        jobName: "Daily bot self improve",
        message: "scan failures and open PRs",
      }),
    ).toBe(true);
    expect(
      isSelfImproveCronRun({
        jobId: "daily-report",
        jobName: "Daily report",
        message: "send heartbeat summary",
      }),
    ).toBe(false);
  });

  it("extracts failures and improvement asks from conversation history", async () => {
    await withTempSessionsDir(async (sessionsDir) => {
      await writeTranscript(sessionsDir, "sess-a.jsonl", [
        {
          timestamp: "2026-03-05T10:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Please add retry support for DB queries in Slack." }],
          },
        },
        {
          timestamp: "2026-03-05T10:00:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I don't have direct DB access from this surface." }],
          },
        },
      ]);
      await writeTranscript(sessionsDir, "sess-b.jsonl", [
        {
          timestamp: "2026-03-05T11:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Could you improve PR descriptions too?" }],
          },
        },
      ]);

      const summary = await buildSelfImproveConversationHistorySummary({
        agentId: "main",
        sessionsDir,
        maxSessions: 10,
      });
      expect(summary).toBeTruthy();
      expect(summary).toContain("Conversation history signals");
      expect(summary).toContain("Potential failures:");
      expect(summary).toContain("I don't have direct DB access");
      expect(summary).toContain("Potential improvements/new features:");
      expect(summary).toContain("Please add retry support for DB queries");
      expect(summary).toContain("Could you improve PR descriptions too");
    });
  });

  it("returns undefined when sessions directory is missing", async () => {
    const summary = await buildSelfImproveConversationHistorySummary({
      agentId: "main",
      sessionsDir: path.join(os.tmpdir(), "openclaw-self-improve-missing"),
    });
    expect(summary).toBeUndefined();
  });

  it("builds a runbook text with optional history section", () => {
    const text = buildSelfImproveRunbookText({
      agentId: "main",
      historySummary: "Conversation history signals (recent sessions):\nPotential failures: ...",
    });
    expect(text).toContain("Self-improvement runbook:");
    expect(text).toContain("session-logs skill");
    expect(text).toContain("Potential failures");
  });
});
