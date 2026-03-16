import { describe, expect, it, vi } from "vitest";

vi.mock("../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveDefaultSessionStorePath: () => "/tmp/test-sessions.json",
  resolveSessionFilePath: () => "/tmp/test-transcript.jsonl",
  loadSessionStore: () => ({
    "telegram:+1234": { sessionId: "sess-1", updatedAt: Date.now() },
  }),
}));

const mockTranscript = vi.hoisted(() => ({
  content: "",
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async () => mockTranscript.content),
  },
}));

const { inferSessionReplyLanguage } = await import("./session-language.js");

describe("inferSessionReplyLanguage", () => {
  it("returns zh-Hans when transcript has Chinese user messages", async () => {
    mockTranscript.content = [
      JSON.stringify({ type: "message", message: { role: "user", content: "你好世界测试" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Hello" } }),
    ].join("\n");

    const result = await inferSessionReplyLanguage({ sessionKey: "telegram:+1234" });
    expect(result).toBe("zh-Hans");
  });

  it("returns en when transcript has English user messages", async () => {
    mockTranscript.content = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Hello how are you doing today" },
      }),
    ].join("\n");

    const result = await inferSessionReplyLanguage({ sessionKey: "telegram:+1234" });
    expect(result).toBe("en");
  });

  it("returns undefined for empty session key", async () => {
    const result = await inferSessionReplyLanguage({ sessionKey: "" });
    expect(result).toBeUndefined();
  });

  it("scans from the end of transcript to find most recent user message", async () => {
    mockTranscript.content = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Hello world testing" },
      }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "..." } }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "你好世界测试一下" },
      }),
    ].join("\n");

    // Should return zh-Hans because the LAST user message is Chinese
    const result = await inferSessionReplyLanguage({ sessionKey: "telegram:+1234" });
    expect(result).toBe("zh-Hans");
  });
});
