import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { incrementCompactionCount } from "./session-updates.js";

async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  entry: Record<string, unknown>;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
    "utf-8",
  );
}

describe("incrementCompactionCount", () => {
  it("increments compaction count", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const entry = { sessionId: "s1", updatedAt: Date.now(), compactionCount: 2 } as SessionEntry;
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
    await seedSessionStore({ storePath, sessionKey, entry });

    const count = await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
    });
    expect(count).toBe(3);

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(3);
  });

  it("updates totalTokens when tokensAfter is provided", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
      totalTokens: 180_000,
      inputTokens: 170_000,
      outputTokens: 10_000,
    } as SessionEntry;
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
    await seedSessionStore({ storePath, sessionKey, entry });

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      tokensAfter: 12_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(1);
    expect(stored[sessionKey].totalTokens).toBe(12_000);
    // input/output cleared since we only have the total estimate
    expect(stored[sessionKey].inputTokens).toBeUndefined();
    expect(stored[sessionKey].outputTokens).toBeUndefined();
  });

  it("does not update totalTokens when tokensAfter is not provided", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
      totalTokens: 180_000,
    } as SessionEntry;
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
    await seedSessionStore({ storePath, sessionKey, entry });

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(1);
    // totalTokens unchanged
    expect(stored[sessionKey].totalTokens).toBe(180_000);
  });
});
