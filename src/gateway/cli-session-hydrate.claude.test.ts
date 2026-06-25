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
  it("emits user+assistant turns with a parentUuid chain and Claude's per-turn fields", () => {
    const jsonl = buildClaudeCliTranscript({
      messages: [
        { role: "user", content: "remember BANANA-42" },
        { role: "assistant", content: "ok, BANANA-42" },
      ],
      sessionId: "sid-1",
      cwd: "/work/proj",
      nowMs: 1_000_000,
    });
    const entries = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: "user",
      parentUuid: null,
      message: { role: "user", content: "remember BANANA-42" },
      permissionMode: "bypassPermissions",
      cwd: "/work/proj",
      sessionId: "sid-1",
    });
    // assistant links to the user's uuid (the chain Claude follows) + content is a text block array
    expect(entries[1]).toMatchObject({
      type: "assistant",
      parentUuid: entries[0].uuid,
      message: { role: "assistant", content: [{ type: "text", text: "ok, BANANA-42" }] },
    });
  });

  it("skips non-text / empty turns and returns '' when there is nothing to hydrate", () => {
    expect(
      buildClaudeCliTranscript({
        messages: [
          { role: "system", content: "x" },
          { role: "user", content: "" },
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
