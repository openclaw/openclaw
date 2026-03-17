import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

// Mock session-utils to avoid config/store dependencies
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadSessionEntry: vi.fn(),
    resolveSessionTranscriptCandidates: vi.fn(),
  };
});

type RespondCall = [boolean, unknown?, { code: string; message: string }?];

function createDeleteMessagesInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return { respond, params };
}

describe("chat.deleteMessages", () => {
  let chatHandlers: Record<string, GatewayRequestHandler>;
  let mockLoadSessionEntry: ReturnType<typeof vi.fn>;
  let mockResolveSessionTranscriptCandidates: ReturnType<typeof vi.fn>;
  let tmpDir: string;

  beforeEach(async () => {
    // Dynamic import after mocks are set up
    const chatMod = await import("./chat.js");
    chatHandlers = chatMod.chatHandlers;

    const sessionUtils = await import("../session-utils.js");
    mockLoadSessionEntry = sessionUtils.loadSessionEntry as ReturnType<typeof vi.fn>;
    mockResolveSessionTranscriptCandidates =
      sessionUtils.resolveSessionTranscriptCandidates as ReturnType<typeof vi.fn>;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-delete-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function invokeHandler(params: Record<string, unknown>) {
    const { respond } = createDeleteMessagesInvokeParams(params);
    const handler = chatHandlers["chat.deleteMessages"];
    void handler({
      params,
      respond: respond as unknown as RespondFn,
      context: {
        logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as never,
      client: null,
      req: { type: "req", id: "req-1", method: "chat.deleteMessages" } as never,
      isWebchatConnect: () => false,
    });
    return respond;
  }

  // ── Param validation ────────────────────────────────────────────────────

  it("returns error when key is missing", () => {
    const respond = invokeHandler({});
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe("INVALID_REQUEST");
    expect(call[2]?.message).toContain("key");
  });

  it("returns error when match is missing", () => {
    const respond = invokeHandler({ key: "test-session" });
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe("INVALID_REQUEST");
    expect(call[2]?.message).toContain("match");
  });

  it("returns error when session not found", () => {
    mockLoadSessionEntry.mockReturnValue({
      storePath: undefined,
      entry: undefined,
    });

    const respond = invokeHandler({ key: "nonexistent", match: { role: "user" } });
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe("INVALID_REQUEST");
    expect(call[2]?.message).toContain("session not found");
  });

  it("returns error when transcript file not found", () => {
    mockLoadSessionEntry.mockReturnValue({
      storePath: tmpDir,
      entry: { sessionId: "sess-1" },
    });
    mockResolveSessionTranscriptCandidates.mockReturnValue([
      path.join(tmpDir, "nonexistent.jsonl"),
    ]);

    const respond = invokeHandler({ key: "test", match: { role: "user" } });
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe("INVALID_REQUEST");
    expect(call[2]?.message).toContain("transcript not found");
  });

  // ── File manipulation ─────────────────────────────────────────────────

  it("deletes matching message from transcript by role and timestamp", () => {
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    const messages = [
      JSON.stringify({ message: { role: "user", timestamp: 1000, content: "hello" } }),
      JSON.stringify({ message: { role: "assistant", timestamp: 1001, content: "hi there" } }),
      JSON.stringify({ message: { role: "user", timestamp: 1002, content: "bye" } }),
    ];
    fs.writeFileSync(transcriptPath, messages.join("\n"), "utf-8");

    mockLoadSessionEntry.mockReturnValue({
      storePath: tmpDir,
      entry: { sessionId: "sess-1" },
    });
    mockResolveSessionTranscriptCandidates.mockReturnValue([transcriptPath]);

    const respond = invokeHandler({
      key: "test",
      match: { role: "user", timestamp: 1000 },
    });
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    expect((call[1] as { deleted: number }).deleted).toBe(1);

    // Verify file contents: should have 2 remaining messages
    const remaining = fs
      .readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    expect(remaining).toHaveLength(2);
    // The first user message (timestamp 1000) should be gone
    const parsed = remaining.map((l) => JSON.parse(l));
    expect(
      parsed.every((p: { message?: { timestamp?: number } }) => p.message?.timestamp !== 1000),
    ).toBe(true);
  });

  it("returns deleted count 0 when no message matches", () => {
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    const messages = [
      JSON.stringify({ message: { role: "user", timestamp: 1000, content: "hello" } }),
      JSON.stringify({ message: { role: "assistant", timestamp: 1001, content: "hi" } }),
    ];
    fs.writeFileSync(transcriptPath, messages.join("\n"), "utf-8");

    mockLoadSessionEntry.mockReturnValue({
      storePath: tmpDir,
      entry: { sessionId: "sess-1" },
    });
    mockResolveSessionTranscriptCandidates.mockReturnValue([transcriptPath]);

    const respond = invokeHandler({
      key: "test",
      match: { role: "user", timestamp: 9999 },
    });
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    expect((call[1] as { deleted: number }).deleted).toBe(0);

    // File should be unchanged (no write when nothing deleted)
    const remaining = fs
      .readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    expect(remaining).toHaveLength(2);
  });

  it("deletes by contentPrefix match", () => {
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    const messages = [
      JSON.stringify({ message: { role: "user", timestamp: 1000, content: "hello world" } }),
      JSON.stringify({ message: { role: "user", timestamp: 1001, content: "help me" } }),
      JSON.stringify({ message: { role: "user", timestamp: 1002, content: "goodbye" } }),
    ];
    fs.writeFileSync(transcriptPath, messages.join("\n"), "utf-8");

    mockLoadSessionEntry.mockReturnValue({
      storePath: tmpDir,
      entry: { sessionId: "sess-1" },
    });
    mockResolveSessionTranscriptCandidates.mockReturnValue([transcriptPath]);

    const respond = invokeHandler({
      key: "test",
      match: { role: "user", contentPrefix: "hel" },
    });
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    // Both "hello world" and "help me" start with "hel"
    expect((call[1] as { deleted: number }).deleted).toBe(2);

    const remaining = fs
      .readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    expect(remaining).toHaveLength(1);
  });

  it("preserves non-message and unparseable lines", () => {
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "metadata", version: 1 }),
      "not valid json {{{",
      JSON.stringify({ message: { role: "user", timestamp: 1000, content: "delete me" } }),
      JSON.stringify({ message: { role: "assistant", timestamp: 1001, content: "kept" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    mockLoadSessionEntry.mockReturnValue({
      storePath: tmpDir,
      entry: { sessionId: "sess-1" },
    });
    mockResolveSessionTranscriptCandidates.mockReturnValue([transcriptPath]);

    const respond = invokeHandler({
      key: "test",
      match: { role: "user", timestamp: 1000 },
    });
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    expect((call[1] as { deleted: number }).deleted).toBe(1);

    // Non-message line, unparseable line, and assistant message should all remain
    const remaining = fs
      .readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    expect(remaining).toHaveLength(3);
  });
});
