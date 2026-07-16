import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTranscriptEvents, upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  readClientVoiceConsultTranscript,
  readClientVoiceSessionEffectsForTest,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";

let tempDir: string;
let previousStateDir: string | undefined;
const sessionKey = "agent:main:main";
const sessionId = "voice-session-agent-transcript";

beforeEach(async () => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-client-voice-session-"));
  process.env.OPENCLAW_STATE_DIR = tempDir;
  await upsertSessionEntry({ agentId: "main", sessionKey }, { sessionId, updatedAt: Date.now() });
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("client voice session ledger", () => {
  it("resumes one logical session and deduplicates finalized transcript entries", () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId: "voice-1",
    });
    expect(voiceSessionId).toBe("voice-1");
    expect(createOrResumeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId })).toBe(
      voiceSessionId,
    );

    appendClientVoiceTranscript({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      entryId: "entry-user",
      role: "user",
      text: "What changed today?",
      timestamp: 100,
    });
    appendClientVoiceTranscript({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      entryId: "entry-user",
      role: "user",
      text: "duplicate",
      timestamp: 101,
    });
    appendClientVoiceTranscript({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      entryId: "entry-assistant",
      role: "assistant",
      text: "I will check Ron's current context.",
      timestamp: 102,
    });

    expect(
      readClientVoiceConsultTranscript({ agentId: "main", sessionKey, voiceSessionId }),
    ).toEqual([
      { role: "user", text: "What changed today?" },
      { role: "assistant", text: "I will check Ron's current context." },
    ]);
  });

  it("imports the full role-preserving transcript exactly once on close", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId: "voice-import",
    });
    appendClientVoiceTranscript({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      entryId: "user-1",
      role: "user",
      text: "Update the dashboard.",
      timestamp: 1_000,
    });
    appendClientVoiceTranscript({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      entryId: "assistant-1",
      role: "assistant",
      text: "The dashboard is updated.",
      timestamp: 2_000,
    });

    await expect(
      closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        persistTranscript: true,
      }),
    ).resolves.toEqual({ imported: 2 });
    await expect(
      closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        persistTranscript: true,
      }),
    ).resolves.toEqual({ imported: 0 });

    const messages = (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey,
      })
    ).flatMap((event) => {
      if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "message") {
        return [];
      }
      return [(event as { message: unknown }).message];
    });
    expect(messages).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
    expect(JSON.stringify(messages)).toContain("Update the dashboard.");
    expect(JSON.stringify(messages)).toContain("The dashboard is updated.");
  });

  it("rejects cross-session resume and transcript access", () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId: "voice-owned",
    });

    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:other",
        voiceSessionId,
      }),
    ).toThrow("does not belong");
    expect(() =>
      readClientVoiceConsultTranscript({
        agentId: "main",
        sessionKey: "agent:main:other",
        voiceSessionId,
      }),
    ).toThrow("does not belong");
  });

  it("records only mutating tool executions correlated to Talk consult runs", () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId: "voice-effects",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      runId: "run-voice",
    });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-voice",
      toolCallId: "read-1",
      toolName: "read",
      mutatingAction: false,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-voice",
      toolCallId: "write-1",
      toolName: "write",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-voice",
      toolCallId: "write-1",
      toolName: "write",
      mutatingAction: true,
      durationMs: 10,
    });

    expect(readClientVoiceSessionEffectsForTest({ agentId: "main", voiceSessionId })).toEqual([
      expect.objectContaining({
        runId: "run-voice",
        toolCallId: "write-1",
        toolName: "write",
        status: "succeeded",
      }),
    ]);
  });

  it("imports and closes abandoned sessions without closing the requested reconnect", async () => {
    const staleVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId: "voice-stale",
      now: 1_000,
    });
    appendClientVoiceTranscript({
      agentId: "main",
      sessionKey,
      voiceSessionId: staleVoiceSessionId,
      entryId: "stale-user",
      role: "user",
      text: "Remember this abandoned call.",
      timestamp: 1_100,
    });
    createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId: staleVoiceSessionId,
      now: 1_000,
    });
    const reconnectVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId: "voice-reconnect",
      now: 1_000,
    });

    await expect(
      closeStaleClientVoiceSessions({
        agentId: "main",
        persistTranscript: true,
        excludeVoiceSessionId: reconnectVoiceSessionId,
        staleAfterMs: 60_000,
        now: 120_000,
      }),
    ).resolves.toBe(1);
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId: staleVoiceSessionId,
      }),
    ).toThrow("already closed");
    expect(
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId: reconnectVoiceSessionId,
      }),
    ).toBe(reconnectVoiceSessionId);
  });
});
