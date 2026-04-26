import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

const hoisted = vi.hoisted(() => {
  const archiveSessionTranscriptsMock = vi.fn();
  const readSessionPreviewItemsFromTranscriptMock = vi.fn();
  return {
    archiveSessionTranscriptsMock,
    readSessionPreviewItemsFromTranscriptMock,
  };
});

vi.mock("../../gateway/session-utils.fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/session-utils.fs.js")>();
  return {
    ...actual,
    archiveSessionTranscripts: (opts: unknown) => hoisted.archiveSessionTranscriptsMock(opts),
    readSessionPreviewItemsFromTranscript: (...args: unknown[]) =>
      hoisted.readSessionPreviewItemsFromTranscriptMock(...args),
  };
});

const { handleSessionsListCommand } = await import("./commands-sessions.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

beforeEach(() => {
  hoisted.archiveSessionTranscriptsMock.mockReset().mockReturnValue([]);
  hoisted.readSessionPreviewItemsFromTranscriptMock.mockReset().mockReturnValue([]);
});

describe("/sessions", () => {
  it("lists the current and prior switchable sessions", async () => {
    const now = Date.now();
    const params = buildCommandTestParams("/sessions", baseCfg, {
      ChatType: "direct",
    });
    params.sessionEntry = {
      sessionId: "session-current-1234",
      sessionFile: "/tmp/current.jsonl",
      updatedAt: now,
      sessionHistory: [
        {
          sessionId: "session-old-5678",
          sessionFile: "/tmp/old.jsonl",
          createdAt: now - 1_000,
          metadata: {},
        },
      ],
    } as SessionEntry;
    params.sessionStore = { [params.sessionKey]: params.sessionEntry };
    hoisted.readSessionPreviewItemsFromTranscriptMock
      .mockReturnValueOnce([{ role: "assistant", text: "current preview" }])
      .mockReturnValueOnce([{ role: "user", text: "older preview" }]);

    const result = await handleSessionsListCommand(params, true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("📋 Sessions:");
    expect(text).toContain("1. [current] session-");
    expect(text).toContain("2. session-");
    expect(text).toContain("Use /sessions <number>, /sessions <sessionId>, or /sessions back.");
  });

  it("switches to a prior session by index and restores metadata", async () => {
    const now = Date.now();
    const params = buildCommandTestParams("/sessions 2", baseCfg, {
      ChatType: "direct",
    });
    params.storePath = "/tmp/session-store.json";
    params.sessionEntry = {
      sessionId: "session-current-1234",
      sessionFile: "/tmp/current.jsonl",
      updatedAt: now,
      sendPolicy: "deny",
      queueMode: "interrupt",
      queueDebounceMs: 250,
      queueCap: 9,
      queueDrop: "old",
      sessionHistory: [
        {
          sessionId: "session-old-5678",
          sessionFile: "/tmp/old.jsonl",
          createdAt: now - 1_000,
          metadata: {
            sendPolicy: "allow",
            queueMode: "collect",
            queueDebounceMs: 1_500,
            queueCap: 3,
            queueDrop: "summarize",
          },
        },
      ],
    } as SessionEntry;
    params.sessionStore = { [params.sessionKey]: params.sessionEntry };
    hoisted.readSessionPreviewItemsFromTranscriptMock.mockReturnValue([
      { role: "assistant", text: "older preview" },
    ]);

    const result = await handleSessionsListCommand(params, true);
    const text = result?.reply?.text ?? "";

    expect(params.sessionEntry.sessionId).toBe("session-old-5678");
    expect(params.sessionEntry.sessionFile).toBe("/tmp/old.jsonl");
    expect(params.sessionEntry.sendPolicy).toBe("allow");
    expect(params.sessionEntry.queueMode).toBe("collect");
    expect(params.sessionEntry.queueDebounceMs).toBe(1_500);
    expect(params.sessionEntry.queueCap).toBe(3);
    expect(params.sessionEntry.queueDrop).toBe("summarize");
    expect(params.sessionEntry.sessionHistory).toEqual([
      expect.objectContaining({
        sessionId: "session-current-1234",
        sessionFile: "/tmp/current.jsonl",
        metadata: expect.objectContaining({
          sendPolicy: "deny",
          queueMode: "interrupt",
          queueDebounceMs: 250,
          queueCap: 9,
          queueDrop: "old",
        }),
      }),
    ]);
    expect(text).toContain("🔄 Switched to session #2");
    expect(text).toContain("Recent: 🤖 older preview");
  });

  it("returns null outside ordinary direct chats", async () => {
    const groupParams = buildCommandTestParams("/sessions", baseCfg, {
      ChatType: "group",
      From: "group-1",
    });
    groupParams.isGroup = true;

    await expect(handleSessionsListCommand(groupParams, true)).resolves.toBeNull();
  });
});
