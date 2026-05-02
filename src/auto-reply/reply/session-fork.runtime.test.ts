import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  forkSessionFromParentRuntime,
  resolveParentForkTokenCountRuntime,
} from "./session-fork.runtime.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveParentForkTokenCountRuntime", () => {
  it("falls back to transcript-estimated tokens when cached totals are stale", async () => {
    const root = await makeRoot("openclaw-parent-fork-token-estimate-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-overflow-transcript";
    const sessionFile = path.join(sessionsDir, "parent.jsonl");
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      }),
    ];
    for (let index = 0; index < 40; index += 1) {
      const body = `turn-${index} ${"x".repeat(12_000)}`;
      lines.push(
        JSON.stringify({
          type: "message",
          id: `u${index}`,
          parentId: index === 0 ? null : `a${index - 1}`,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: body },
        }),
        JSON.stringify({
          type: "message",
          id: `a${index}`,
          parentId: `u${index}`,
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: body },
        }),
      );
    }
    await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 1,
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(root, "sessions.json"),
    });

    expect(tokens).toBeGreaterThan(100_000);
  });
});

describe("forkSessionFromParentRuntime", () => {
  it("forks the active branch without synchronously opening the session manager", async () => {
    const root = await makeRoot("openclaw-parent-fork-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    const parentSessionId = "parent-session";
    const lines = [
      {
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-05-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-05-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        type: "label",
        id: "label-1",
        parentId: "assistant-1",
        timestamp: "2026-05-01T00:00:03.000Z",
        targetId: "user-1",
        label: "start",
      },
    ];
    await fs.writeFile(
      parentSessionFile,
      `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    expect(fork).not.toBeNull();
    expect(fork?.sessionFile).toContain(sessionsDir);
    expect(fork?.sessionId).not.toBe(parentSessionId);
    const raw = await fs.readFile(fork?.sessionFile ?? "", "utf-8");
    const forkedEntries = raw
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const resolvedParentSessionFile = await fs.realpath(parentSessionFile);
    expect(forkedEntries[0]).toMatchObject({
      type: "session",
      id: fork?.sessionId,
      cwd,
      parentSession: resolvedParentSessionFile,
    });
    expect(forkedEntries.map((entry) => entry.type)).toEqual([
      "session",
      "message",
      "message",
      "label",
    ]);
    expect(forkedEntries.at(-1)).toMatchObject({
      type: "label",
      targetId: "user-1",
      label: "start",
    });
  });

  it("creates a header-only child when the parent has no entries", async () => {
    const root = await makeRoot("openclaw-parent-fork-empty-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const parentSessionId = "parent-empty";
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: parentSessionId,
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd: root,
      })}\n`,
      "utf-8",
    );

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    expect(fork).not.toBeNull();
    const raw = await fs.readFile(fork?.sessionFile ?? "", "utf-8");
    const lines = raw.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    const resolvedParentSessionFile = await fs.realpath(parentSessionFile);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "session",
      id: fork?.sessionId,
      parentSession: resolvedParentSessionFile,
    });
  });
});
