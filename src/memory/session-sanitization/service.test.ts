import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  cleanupSessionSanitizationArtifacts,
  recallSessionMemory,
  writeTranscriptTurnToSessionMemory,
} from "./service.js";
import {
  appendSessionMemorySummaryEntry,
  readSessionMemoryAuditEntries,
  readSessionMemoryRawEntries,
  readSessionMemorySummaryEntries,
  resolveSessionMemoryAuditFile,
  resolveSessionMemorySummaryFile,
  writeSessionMemoryRawEntry,
} from "./storage.js";

const AGENT_ID = "main";
const SESSION_ID = "sess-1";

function createConfig(): OpenClawConfig {
  return {
    memory: {
      sessions: {
        sanitization: {
          enabled: true,
        },
      },
    },
    agents: {
      defaults: {
        sandbox: {
          mode: "non-main",
        },
      },
    },
  };
}

function createRunnerResult(payload: unknown) {
  return {
    payloads: [{ text: JSON.stringify(payload) }],
    meta: { durationMs: 1 },
  };
}

function createCanonicalContext(overrides?: Partial<Record<string, unknown>>) {
  return {
    from: "user",
    content: "call mom tomorrow",
    transcript: "Call mom tomorrow at 9",
    body: "Call mom tomorrow",
    bodyForAgent: "Call mom tomorrow at 9",
    timestamp: Date.parse("2026-03-03T10:00:00.000Z"),
    channelId: "telegram",
    conversationId: "chat-1",
    messageId: "msg-1",
    provider: "telegram",
    surface: "telegram",
    isGroup: false,
    ...overrides,
  };
}

describe("session sanitization service", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir = "";

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-test-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  it("writes raw entries, sanitized summaries, and audit events", async () => {
    const runner = vi
      .fn()
      .mockResolvedValue(
        createRunnerResult({
          mode: "write",
          decisions: ["Call mom tomorrow morning."],
          actionItems: ["Call mom tomorrow at 9."],
          entities: ["mom"],
          contextNote: "User asked to remember a follow-up call.",
          discard: false,
        }),
      );

    await writeTranscriptTurnToSessionMemory({
      cfg: createConfig(),
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      canonical: createCanonicalContext(),
      helperDeps: { runner },
    });

    const rawEntries = await readSessionMemoryRawEntries({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    const summaries = await readSessionMemorySummaryEntries({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    const audit = await readSessionMemoryAuditEntries({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });

    expect(rawEntries).toHaveLength(1);
    expect(rawEntries[0]?.entry.transcript).toBe("Call mom tomorrow at 9");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.messageId).toBe("msg-1");
    expect(summaries[0]?.actionItems).toEqual(["Call mom tomorrow at 9."]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.event).toBe("write");
  });

  it("records discard decisions without appending a summary entry", async () => {
    const runner = vi
      .fn()
      .mockResolvedValue(
        createRunnerResult({
          mode: "write",
          decisions: [],
          actionItems: [],
          entities: [],
          discard: true,
        }),
      );

    await writeTranscriptTurnToSessionMemory({
      cfg: createConfig(),
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      canonical: createCanonicalContext({
        messageId: "msg-discard",
        transcript: "uh huh okay sure",
      }),
      helperDeps: { runner },
    });

    const summaries = await readSessionMemorySummaryEntries({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    const audit = await readSessionMemoryAuditEntries({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });

    expect(summaries).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.event).toBe("discard");
    expect(audit[0]?.messageId).toBe("msg-discard");
  });

  it("returns high confidence only for raw-backed recall", async () => {
    await appendSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-raw",
        timestamp: "2026-03-03T10:00:00.000Z",
        rawExpiresAt: "2099-03-03T10:00:00.000Z",
        decisions: ["Call mom tomorrow."],
        actionItems: ["Call mom tomorrow at 9."],
        entities: ["mom"],
        contextNote: "Follow-up reminder",
        discard: false,
      },
    });
    await writeSessionMemoryRawEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-raw",
        timestamp: "2026-03-03T10:00:00.000Z",
        expiresAt: "2099-03-03T10:00:00.000Z",
        transcript: "Call mom tomorrow at 9",
      },
    });

    const result = await recallSessionMemory({
      cfg: createConfig(),
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      query: "call mom",
      helperDeps: {
        runner: vi.fn().mockResolvedValue(
          createRunnerResult({
            mode: "recall",
            result: "You planned to call your mom tomorrow at 9.",
            source: "raw",
            matchedSummaryIds: ["msg-raw"],
            usedRawMessageIds: ["msg-raw"],
          }),
        ),
      },
    });

    expect(result.confidence).toBe("high");
    expect(result.source).toBe("raw");
  });

  it("returns medium confidence only for dense summary-backed matches that are not all post-expiry", async () => {
    await appendSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-medium",
        timestamp: "2026-03-03T10:00:00.000Z",
        rawExpiresAt: "2099-03-03T10:00:00.000Z",
        decisions: ["Reach out to Alex."],
        actionItems: ["Send Alex the draft."],
        entities: ["Alex"],
        contextNote: "Pending review task",
        discard: false,
      },
    });

    const result = await recallSessionMemory({
      cfg: createConfig(),
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      query: "Alex draft",
      helperDeps: {
        runner: vi.fn().mockResolvedValue(
          createRunnerResult({
            mode: "recall",
            result: "You wanted to send Alex the draft for review.",
            source: "summary",
            matchedSummaryIds: ["msg-medium"],
            usedRawMessageIds: [],
          }),
        ),
      },
    });

    expect(result.confidence).toBe("medium");
    expect(result.source).toBe("summary");
  });

  it("returns low confidence for sparse summary-only recall and post-expiry summary-only recall", async () => {
    await appendSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-sparse",
        timestamp: "2026-03-03T10:00:00.000Z",
        rawExpiresAt: "2099-03-03T10:00:00.000Z",
        decisions: [],
        actionItems: [],
        entities: ["printer"],
        discard: false,
      },
    });
    await appendSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-expired",
        timestamp: "2026-03-03T10:00:00.000Z",
        rawExpiresAt: "2020-03-03T10:00:00.000Z",
        decisions: ["Book dentist appointment."],
        actionItems: ["Book dentist appointment next week."],
        entities: ["dentist"],
        contextNote: "Health follow-up",
        discard: false,
      },
    });

    const sparse = await recallSessionMemory({
      cfg: createConfig(),
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      query: "printer",
      helperDeps: {
        runner: vi.fn().mockResolvedValue(
          createRunnerResult({
            mode: "recall",
            result: "There was a note about the printer.",
            source: "summary",
            matchedSummaryIds: ["msg-sparse"],
            usedRawMessageIds: [],
          }),
        ),
      },
    });
    const expired = await recallSessionMemory({
      cfg: createConfig(),
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      query: "dentist",
      helperDeps: {
        runner: vi.fn().mockResolvedValue(
          createRunnerResult({
            mode: "recall",
            result: "You planned to book a dentist appointment next week.",
            source: "summary",
            matchedSummaryIds: ["msg-expired"],
            usedRawMessageIds: [],
          }),
        ),
      },
    });

    expect(sparse.confidence).toBe("low");
    expect(expired.confidence).toBe("low");
  });

  it("cleans up raw, summary, and audit sidecars for a session", async () => {
    await writeSessionMemoryRawEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-cleanup",
        timestamp: "2026-03-03T10:00:00.000Z",
        expiresAt: "2099-03-03T10:00:00.000Z",
        transcript: "cleanup test",
      },
    });
    await appendSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-cleanup",
        timestamp: "2026-03-03T10:00:00.000Z",
        rawExpiresAt: "2099-03-03T10:00:00.000Z",
        decisions: ["cleanup"],
        actionItems: [],
        entities: [],
        discard: false,
      },
    });

    await cleanupSessionSanitizationArtifacts({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });

    await expect(
      fs.stat(resolveSessionMemorySummaryFile(AGENT_ID, SESSION_ID)),
    ).rejects.toThrow();
    await expect(
      fs.stat(resolveSessionMemoryAuditFile(AGENT_ID, SESSION_ID)),
    ).rejects.toThrow();
    expect(
      await readSessionMemoryRawEntries({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
      }),
    ).toHaveLength(0);
  });
});
