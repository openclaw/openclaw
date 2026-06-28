// Tests parent-session fork facade storage-boundary behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { replaceSqliteTranscriptEvents } from "../../config/sessions/session-accessor.sqlite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { forkSessionEntryFromParent, resolveParentForkDecision } from "./session-fork.js";

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("forkSessionEntryFromParent", () => {
  it("forks the active parent branch into SQLite and persists the child entry", async () => {
    const root = makeRoot("openclaw-session-fork-boundary-");
    const activeStoreDir = path.join(root, "active-store");
    const configStoreDir = path.join(root, "config-store");
    fs.mkdirSync(activeStoreDir, { recursive: true });
    fs.mkdirSync(configStoreDir, { recursive: true });
    const storePath = path.join(activeStoreDir, "sessions.json");
    const configStorePath = path.join(configStoreDir, "sessions.json");
    const parentSessionKey = "agent:main:main";
    const sessionKey = "agent:main:subagent:child";
    const staleSessionKey = "agent:main:subagent:stale-child";

    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: staleSessionKey,
        storePath,
      },
      {
        sessionId: "stale-child-session",
        updatedAt: 2,
      },
    );
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: parentSessionKey,
        storePath,
      },
      {
        sessionId: "parent-session",
        totalTokens: 10,
        totalTokensFresh: true,
        updatedAt: 10,
      },
    );
    await replaceSqliteTranscriptEvents(
      {
        agentId: "main",
        sessionId: "parent-session",
        sessionKey: parentSessionKey,
        storePath,
      },
      [
        {
          type: "session",
          version: 3,
          id: "parent-session",
          timestamp: "2026-06-27T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "root",
          parentId: null,
          timestamp: "2026-06-27T00:00:01.000Z",
          message: { role: "user", content: "root prompt" },
        },
        {
          type: "message",
          id: "inactive-answer",
          parentId: "root",
          timestamp: "2026-06-27T00:00:02.000Z",
          message: { role: "assistant", content: "stale answer" },
        },
        {
          type: "message",
          id: "active-answer",
          parentId: "root",
          timestamp: "2026-06-27T00:00:03.000Z",
          message: { role: "assistant", content: "active answer" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "inactive-answer",
          timestamp: "2026-06-27T00:00:04.000Z",
          targetId: "active-answer",
        },
      ],
    );

    const result = await forkSessionEntryFromParent({
      agentId: "main",
      config: { session: { store: configStorePath } } as OpenClawConfig,
      fallbackEntry: { sessionId: "", updatedAt: 2 },
      parentSessionKey,
      parentStoreKeys: [parentSessionKey],
      sessionKey,
      sessionStoreKeys: [sessionKey, staleSessionKey],
      storePath,
      patch: () => ({ label: "forked child", updatedAt: 3 }),
    });

    expect(result.status).toBe("forked");
    if (result.status !== "forked") {
      throw new Error("expected fork");
    }
    expect(result.fork.sessionId).not.toBe("parent-session");
    expect(result.fork.sessionFile).toContain(`sqlite:main:${result.fork.sessionId}:`);
    expect(fs.existsSync(storePath)).toBe(false);

    const stored = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(stored).toMatchObject({
      forkedFromParent: true,
      label: "forked child",
      sessionFile: result.fork.sessionFile,
      sessionId: result.fork.sessionId,
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: staleSessionKey, storePath })).toBe(
      undefined,
    );

    const events = (await loadTranscriptEvents({
      agentId: "main",
      sessionId: result.fork.sessionId,
      sessionKey,
      storePath,
    })) as Array<{ id?: string; message?: { content?: string }; type?: string }>;
    const branchEvents = events.filter((event) => event.type !== "session");
    expect(branchEvents.map((event) => event.id).filter(Boolean)).toEqual([
      "root",
      "active-answer",
      expect.any(String),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        id: "active-answer",
        message: expect.objectContaining({ content: "active answer" }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        id: "inactive-answer",
      }),
    );
  });

  it("marks the child as handled when the SQLite parent is over the fork limit", async () => {
    const root = makeRoot("openclaw-session-fork-large-");
    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:main";
    const sessionKey = "agent:main:subagent:child";
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: parentSessionKey,
        storePath,
      },
      {
        sessionId: "parent-session",
        totalTokens: 150_000,
        totalTokensFresh: true,
        updatedAt: 1,
      },
    );

    const result = await forkSessionEntryFromParent({
      agentId: "main",
      fallbackEntry: { sessionId: "", updatedAt: 2 },
      parentSessionKey,
      sessionKey,
      storePath,
      decisionSkipPatch: () => ({ forkedFromParent: true, updatedAt: 3 }),
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "decision-skip",
      decision: {
        status: "skip",
        reason: "parent-too-large",
        parentTokens: 150_000,
      },
      sessionEntry: {
        forkedFromParent: true,
        sessionId: "",
        updatedAt: expect.any(Number),
      },
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
      forkedFromParent: true,
      sessionId: "",
      updatedAt: expect.any(Number),
    });
  });

  it("skips stale-token SQLite parents using transcript usage estimates", async () => {
    const root = makeRoot("openclaw-session-fork-stale-large-");
    const storePath = path.join(root, "sessions.json");
    const parentEntry = {
      sessionId: "parent-session",
      totalTokens: 1,
      totalTokensFresh: false,
      updatedAt: 1,
    };
    await replaceSqliteTranscriptEvents(
      {
        agentId: "main",
        sessionId: parentEntry.sessionId,
        sessionKey: "agent:main:main",
        storePath,
      },
      [
        {
          type: "session",
          version: 3,
          id: parentEntry.sessionId,
          timestamp: "2026-06-27T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "large-answer",
          parentId: null,
          timestamp: "2026-06-27T00:00:01.000Z",
          message: {
            role: "assistant",
            content: "x".repeat(420_000),
          },
        },
      ],
    );

    await expect(resolveParentForkDecision({ parentEntry, storePath })).resolves.toMatchObject({
      status: "skip",
      reason: "parent-too-large",
      parentTokens: expect.any(Number),
    });
  });
});
