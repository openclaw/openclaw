import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeCliSessionMessages } from "./cli-session-history.claude.js";
import {
  buildClaudeCliTranscript,
  hydrateClaudeCliTranscript,
} from "./cli-session-hydrate.claude.js";

describe("PR7 hydration — buildClaudeCliTranscript", () => {
  const parse = (jsonl: string) =>
    jsonl
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  it("emits a user turn with Claude's exact per-turn fields", () => {
    const [u] = parse(
      buildClaudeCliTranscript({
        messages: [{ role: "user", content: "remember BANANA-42" }],
        sessionId: "sid-1",
        cwd: "/work/proj",
        nowMs: 1_000_000,
      }),
    );
    expect(u).toMatchObject({
      type: "user",
      parentUuid: null,
      message: { role: "user", content: "remember BANANA-42" },
      permissionMode: "bypassPermissions",
      promptSource: "sdk",
      isSidechain: false,
      userType: "external",
      entrypoint: "sdk-cli",
      cwd: "/work/proj",
      sessionId: "sid-1",
      version: "2.1.191",
      gitBranch: "",
    });
    expect(typeof u.uuid).toBe("string");
    expect(typeof u.promptId).toBe("string");
    expect(u.promptId).not.toBe(u.uuid); // a distinct promptId, not a reused uuid
    expect(u.timestamp).toBe(new Date(1_000_000).toISOString());
  });

  it("emits an assistant turn as a text-block array with model + requestId, omitting user-only fields", () => {
    const [a] = parse(
      buildClaudeCliTranscript({
        messages: [{ role: "assistant", content: "ok, BANANA-42" }],
        sessionId: "sid-1",
        cwd: "/c",
        nowMs: 0,
      }),
    );
    expect(a).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "ok, BANANA-42" }],
      },
      userType: "external",
      entrypoint: "sdk-cli",
      version: "2.1.191",
    });
    expect(a.requestId).toMatch(/^req_hydrated_[0-9a-f-]{12}$/); // uuid.slice(0,12) keeps the hyphen
    expect(a).not.toHaveProperty("permissionMode");
    expect(a).not.toHaveProperty("promptId");
  });

  it("links turns through the parentUuid chain in message order", () => {
    const entries = parse(
      buildClaudeCliTranscript({
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
        ],
        sessionId: "s",
        cwd: "/c",
        nowMs: 0,
      }),
    );
    expect(entries.map((e) => e.message.content?.[0]?.text ?? e.message.content)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(entries[0].parentUuid).toBeNull();
    expect(entries[1].parentUuid).toBe(entries[0].uuid);
    expect(entries[2].parentUuid).toBe(entries[1].uuid);
  });

  it("flattens array content to one text block, dropping non-text and non-string-text blocks", () => {
    const [a] = parse(
      buildClaudeCliTranscript({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "A" },
              "B",
              { type: "image" },
              { text: 5 },
              { type: "text", text: "C" },
            ],
          },
        ],
        sessionId: "s",
        cwd: "/c",
        nowMs: 0,
      }),
    );
    // text-block "A", string-block "B", text-block "C" kept; {type:image} and {text:5} (non-string) dropped
    expect(a.message.content).toEqual([{ type: "text", text: "A\nB\nC" }]);
  });

  it("preserves a string timestamp, converts a numeric one, and falls back to nowMs", () => {
    const ts = (
      msg: { role: string; content: unknown; timestamp?: number | string },
      nowMs: number,
    ) =>
      parse(buildClaudeCliTranscript({ messages: [msg], sessionId: "s", cwd: "/c", nowMs }))[0]
        .timestamp;
    expect(ts({ role: "user", content: "x", timestamp: "2020-06-01T00:00:00.000Z" }, 999)).toBe(
      "2020-06-01T00:00:00.000Z",
    );
    expect(ts({ role: "user", content: "x", timestamp: 1_600_000_000_000 }, 999)).toBe(
      new Date(1_600_000_000_000).toISOString(),
    );
    expect(ts({ role: "user", content: "x" }, 1_234_567)).toBe(new Date(1_234_567).toISOString());
  });

  it("skips non-text / empty turns and returns '' when there is nothing to hydrate", () => {
    expect(
      buildClaudeCliTranscript({
        messages: [
          { role: "system", content: "x" },
          { role: "user", content: "" },
          { role: "assistant", content: [{ type: "image" }] },
        ],
        sessionId: "s",
        cwd: "/c",
        nowMs: 0,
      }),
    ).toBe("");
  });
});

describe("PR7 hydration — round-trips through PR4's own reader", () => {
  let home = "";
  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a hydrated transcript is parsed back by readClaudeCliSessionMessages", () => {
    home = mkdtempSync(join(tmpdir(), "hydr-"));
    const path = hydrateClaudeCliTranscript({
      messages: [
        { role: "user", content: "hello from the gateway session" },
        { role: "assistant", content: "hi there, picked up where we left off" },
      ],
      sessionId: "round-trip-sid",
      cwd: "/work/proj",
      nowMs: 1_000_000,
      homeDir: home,
    });
    expect(path).toBeTruthy();
    // the same reader PR4 uses to import claude transcripts parses what we hydrated — consistent both ways
    const messages = readClaudeCliSessionMessages({
      cliSessionId: "round-trip-sid",
      homeDir: home,
    });
    const dump = JSON.stringify(messages);
    expect(dump).toContain("hello from the gateway session");
    expect(dump).toContain("hi there, picked up where we left off");
  });
});
