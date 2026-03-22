import { describe, expect, it } from "vitest";
import {
  matchesContextTrigger,
  formatPrefetchAsSystemMessage,
  type MemoryPrefetchResult,
} from "./agent-runner-memory.js";

describe("matchesContextTrigger", () => {
  it("matches 'remember' keyword", () => {
    expect(matchesContextTrigger("do you remember the email setup?")).toBe(true);
  });
  it("matches 'last time' keyword", () => {
    expect(matchesContextTrigger("last time we discussed this")).toBe(true);
  });
  it("matches 'yesterday' keyword", () => {
    expect(matchesContextTrigger("what did we do yesterday?")).toBe(true);
  });
  it("does not match generic greetings", () => {
    expect(matchesContextTrigger("hello, how are you?")).toBe(false);
  });
  it("does not match simple commands", () => {
    expect(matchesContextTrigger("check my email")).toBe(false);
  });
  it("matches 'pending' keyword", () => {
    expect(matchesContextTrigger("what tasks are pending?")).toBe(true);
  });
  it("is case insensitive", () => {
    expect(matchesContextTrigger("Do You REMEMBER?")).toBe(true);
  });
});

describe("formatPrefetchAsSystemMessage", () => {
  it("formats results with file path and line", () => {
    const prefetch: MemoryPrefetchResult = {
      results: [
        { path: "memory/2026-03-20.md", line: 12, content: "User asked about email", score: 0.9 },
      ],
      query: "email setup",
    };
    const msg = formatPrefetchAsSystemMessage(prefetch);
    expect(msg).toContain("memory/2026-03-20.md#L12");
    expect(msg).toContain("User asked about email");
  });
  it("formats results without line number", () => {
    const prefetch: MemoryPrefetchResult = {
      results: [{ path: "memory/2026-03-20.md", content: "Some content", score: 0.8 }],
      query: "test",
    };
    const msg = formatPrefetchAsSystemMessage(prefetch);
    expect(msg).toContain("memory/2026-03-20.md");
    expect(msg).not.toContain("#L");
  });
});
