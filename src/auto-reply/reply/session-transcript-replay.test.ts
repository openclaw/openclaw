import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REPLAY_MAX_MESSAGES,
  replayRecentUserAssistantMessages,
} from "./session-transcript-replay.js";

const j = (obj: unknown): string => `${JSON.stringify(obj)}\n`;

describe("replayRecentUserAssistantMessages", () => {
  let root = "";
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = (source: string, target: string): Promise<number> =>
    replayRecentUserAssistantMessages({
      sourceTranscript: source,
      targetTranscript: target,
      newSessionId: "new-session",
    });

  it("replays only the user/assistant tail and skips tool/system/malformed records", async () => {
    const source = path.join(root, "prev.jsonl");
    const target = path.join(root, "next.jsonl");
    const lines: string[] = [j({ type: "session", id: "old" })];
    for (let i = 0; i < DEFAULT_REPLAY_MAX_MESSAGES + 4; i += 1) {
      lines.push(j({ message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` } }));
    }
    lines.push(j({ message: { role: "tool" } }));
    lines.push(j({ type: "compaction", timestamp: new Date().toISOString() }));
    lines.push("not-json-line\n");
    await fs.writeFile(source, lines.join(""), "utf8");

    expect(await call(source, target)).toBe(DEFAULT_REPLAY_MAX_MESSAGES);
    const records = (await fs.readFile(target, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ type: "session", id: "new-session" });
    expect(records).toHaveLength(1 + DEFAULT_REPLAY_MAX_MESSAGES);
    for (const r of records.slice(1)) {
      expect(["user", "assistant"]).toContain(r.message.role);
    }
    expect(await call(path.join(root, "missing.jsonl"), path.join(root, "out.jsonl"))).toBe(0);
  });

  it("skips header for pre-existing targets and aligns the tail to a user turn", async () => {
    const source = path.join(root, "prev.jsonl");
    const target = path.join(root, "next.jsonl");
    await fs.writeFile(target, j({ type: "session", id: "existing" }), "utf8");
    const lines: string[] = [];
    for (let i = 0; i < DEFAULT_REPLAY_MAX_MESSAGES + 1; i += 1) {
      lines.push(j({ message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` } }));
    }
    await fs.writeFile(source, lines.join(""), "utf8");

    expect(await call(source, target)).toBe(DEFAULT_REPLAY_MAX_MESSAGES - 1);
    const records = (await fs.readFile(target, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(records.filter((r) => r.type === "session")).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "existing" });
    expect(records[1].message.role).toBe("user");
  });
});
