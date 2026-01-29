import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadBookmarks,
  saveBookmarks,
  sessionsBookmarkCommand,
  sessionsSearchCommand,
} from "./sessions-search.js";

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    exit: (code: number) => {
      throw new Error(`exit(${code})`);
    },
    logs,
    errors,
  };
}

describe("sessionsSearchCommand", () => {
  let tmpDir: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-search-test-"));
    origEnv = process.env.CLAWDBOT_STATE_DIR;
    process.env.CLAWDBOT_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    if (origEnv !== undefined) {
      process.env.CLAWDBOT_STATE_DIR = origEnv;
    } else {
      delete process.env.CLAWDBOT_STATE_DIR;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTranscript(agentId: string, sessionKey: string, lines: object[]) {
    const dir = path.join(tmpDir, "agents", agentId, "sessions");
    await fs.promises.mkdir(dir, { recursive: true });
    const content = lines.map((l) => JSON.stringify(l)).join("\n");
    await fs.promises.writeFile(path.join(dir, `${sessionKey}.jsonl`), content, "utf-8");
  }

  it("finds matching messages in transcripts", async () => {
    await writeTranscript("pi", "main", [
      { role: "user", content: "Hello world", timestamp: Date.now() },
      { role: "assistant", content: "Hi there", timestamp: Date.now() },
      { role: "user", content: "Deploy the API", timestamp: Date.now() },
    ]);

    const runtime = createRuntime();
    await sessionsSearchCommand({ query: "deploy" }, runtime);
    expect(runtime.logs.some((l) => l.includes("deploy") || l.includes("Deploy"))).toBe(true);
    expect(runtime.logs.some((l) => l.includes("1 result"))).toBe(true);
  });

  it("returns no results for non-matching query", async () => {
    await writeTranscript("pi", "main", [
      { role: "user", content: "Hello world", timestamp: Date.now() },
    ]);

    const runtime = createRuntime();
    await sessionsSearchCommand({ query: "nonexistent-query-xyz" }, runtime);
    expect(runtime.logs.some((l) => l.includes("No matches"))).toBe(true);
  });

  it("filters by agent", async () => {
    await writeTranscript("pi", "main", [
      { role: "user", content: "alpha message", timestamp: Date.now() },
    ]);
    await writeTranscript("other", "main", [
      { role: "user", content: "alpha message", timestamp: Date.now() },
    ]);

    const runtime = createRuntime();
    await sessionsSearchCommand({ query: "alpha", agent: "pi" }, runtime);
    expect(runtime.logs.some((l) => l.includes("1 result"))).toBe(true);
  });

  it("outputs JSON when requested", async () => {
    await writeTranscript("pi", "main", [
      { role: "user", content: "test message", timestamp: "2024-01-15T10:00:00Z" },
    ]);

    const runtime = createRuntime();
    await sessionsSearchCommand({ query: "test", json: true }, runtime);
    const output = runtime.logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].content).toContain("test message");
  });

  it("respects limit", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({
      role: "user",
      content: `matching line ${i}`,
      timestamp: Date.now(),
    }));
    await writeTranscript("pi", "main", lines);

    const runtime = createRuntime();
    await sessionsSearchCommand({ query: "matching", limit: 5, json: true }, runtime);
    const parsed = JSON.parse(runtime.logs.join("\n"));
    expect(parsed.count).toBe(5);
  });

  it("handles empty state directory", async () => {
    const runtime = createRuntime();
    await sessionsSearchCommand({ query: "anything" }, runtime);
    expect(runtime.logs.some((l) => l.includes("No session transcripts"))).toBe(true);
  });

  it("filters by since period", async () => {
    const now = Date.now();
    await writeTranscript("pi", "main", [
      { role: "user", content: "old message", timestamp: now - 86_400_000 * 3 },
      { role: "user", content: "recent message", timestamp: now - 3_600_000 },
    ]);

    const runtime = createRuntime();
    await sessionsSearchCommand({ query: "message", since: "1d" }, runtime);
    expect(runtime.logs.some((l) => l.includes("1 result"))).toBe(true);
  });
});

describe("bookmarks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "moltbot-bm-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads empty bookmarks from missing file", () => {
    const bm = loadBookmarks(tmpDir);
    expect(bm.size).toBe(0);
  });

  it("saves and loads bookmarks", async () => {
    const bm = new Set(["pi:main:5", "pi:chat:10"]);
    await saveBookmarks(tmpDir, bm);
    const loaded = loadBookmarks(tmpDir);
    expect(loaded.size).toBe(2);
    expect(loaded.has("pi:main:5")).toBe(true);
  });

  it("bookmark command adds and lists", async () => {
    const origEnv = process.env.CLAWDBOT_STATE_DIR;
    process.env.CLAWDBOT_STATE_DIR = tmpDir;
    try {
      const runtime = createRuntime();
      await sessionsBookmarkCommand({ add: "pi:main:42" }, runtime);
      expect(runtime.logs.some((l) => l.includes("Bookmarked"))).toBe(true);

      const runtime2 = createRuntime();
      await sessionsBookmarkCommand({ list: true }, runtime2);
      expect(runtime2.logs.some((l) => l.includes("pi:main:42"))).toBe(true);
    } finally {
      if (origEnv !== undefined) {
        process.env.CLAWDBOT_STATE_DIR = origEnv;
      } else {
        delete process.env.CLAWDBOT_STATE_DIR;
      }
    }
  });
});
