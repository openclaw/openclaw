import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSqliteSessionTranscriptEvent } from "../config/sessions/transcript-store.sqlite.js";
import { saveCronStore } from "../cron/store.js";
import type { CronStoreFile } from "../cron/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  formatCronSessionDiagnosticFields,
  formatStoppedCronSessionDiagnosticFields,
  parseCronRunSessionKey,
  readLastAssistantFromSqliteTranscript,
  resolveCronSessionDiagnosticContext,
} from "./diagnostic-session-context.js";

let tempDir: string | undefined;
let previousStateDir: string | undefined;

async function writeCronJob(id: string, name: string) {
  const now = Date.now();
  const store: CronStoreFile = {
    version: 1,
    jobs: [
      {
        id,
        name,
        enabled: true,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "run" },
        state: {},
      },
    ],
  };
  await saveCronStore(path.join(tempDir!, "cron", "jobs.json"), store);
}

function appendAssistantEvent(params: { sessionId: string; text: string; id: string }) {
  appendSqliteSessionTranscriptEvent({
    agentId: "clawblocker",
    sessionId: params.sessionId,
    event: {
      type: "message",
      id: params.id,
      message: {
        role: "assistant",
        content: [{ type: "text", text: params.text }],
      },
    },
  });
}

describe("diagnostic session context", () => {
  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-diagnostic-session-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = undefined;
  });

  it("parses cron run session keys", () => {
    expect(parseCronRunSessionKey("agent:clawblocker:cron:job-123:run:run-456")).toEqual({
      agentId: "clawblocker",
      cronJobId: "job-123",
      cronRunId: "run-456",
    });
  });

  it("formats cron job and last assistant context for stalled session logs", async () => {
    await writeCronJob("job-123", "Twitter Mention Moderation Agent");
    appendAssistantEvent({
      sessionId: "run-456",
      id: "message-1",
      text: "There are 40\ncached mentions ready.",
    });

    const context = resolveCronSessionDiagnosticContext({
      sessionKey: "agent:clawblocker:cron:job-123:run:run-456",
    });

    expect(formatCronSessionDiagnosticFields(context)).toContain("cronJobId=job-123");
    expect(formatCronSessionDiagnosticFields(context)).toContain("cronRunId=run-456");
    expect(formatCronSessionDiagnosticFields(context)).toContain(
      'cronJob="Twitter Mention Moderation Agent"',
    );
    expect(formatCronSessionDiagnosticFields(context)).toContain(
      'lastAssistant="There are 40 cached mentions ready."',
    );
    expect(formatStoppedCronSessionDiagnosticFields(context)).toContain(
      'stopped="Twitter Mention Moderation Agent"',
    );
  });

  it("reads the latest assistant message from SQLite transcript events", () => {
    appendAssistantEvent({ sessionId: "session-1", id: "message-1", text: "older" });
    appendSqliteSessionTranscriptEvent({
      agentId: "clawblocker",
      sessionId: "session-1",
      event: { type: "message", id: "message-2", message: { role: "user", content: "later user" } },
    });
    appendAssistantEvent({ sessionId: "session-1", id: "message-3", text: "newer" });

    expect(
      readLastAssistantFromSqliteTranscript({
        agentId: "clawblocker",
        sessionId: "session-1",
      }),
    ).toBe("newer");
  });

  it("ignores missing SQLite transcript events", () => {
    expect(
      readLastAssistantFromSqliteTranscript({
        agentId: "clawblocker",
        sessionId: "missing",
      }),
    ).toBeUndefined();
  });
});
