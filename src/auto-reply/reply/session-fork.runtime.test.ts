import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  forkSessionFromParentRuntime,
  resolveParentForkTokenCountRuntime,
} from "./session-fork.runtime.js";

const roots: string[] = [];
let originalStateDir: string | undefined;

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  originalStateDir = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function useStateRoot(root: string): void {
  originalStateDir ??= process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
}

function seedTranscript(params: {
  agentId?: string;
  sessionId: string;
  transcriptPath: string;
  events: unknown[];
}): void {
  replaceSqliteSessionTranscriptEvents({
    agentId: params.agentId ?? "main",
    sessionId: params.sessionId,
    transcriptPath: params.transcriptPath,
    events: params.events,
    now: () => 1_770_000_000_000,
  });
}

function readTranscript(agentId: string, sessionId: string): unknown[] {
  return loadSqliteSessionTranscriptEvents({ agentId, sessionId }).map((entry) => entry.event);
}

describe("resolveParentForkTokenCountRuntime", () => {
  it("falls back to recent transcript usage when cached totals are stale", async () => {
    const root = await makeRoot("openclaw-parent-fork-token-estimate-");
    useStateRoot(root);
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-overflow-transcript";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    const events: unknown[] = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      },
    ];
    for (let index = 0; index < 40; index += 1) {
      const body = `turn-${index} ${"x".repeat(200)}`;
      events.push(
        {
          type: "message",
          id: `u${index}`,
          parentId: index === 0 ? null : `a${index - 1}`,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: body },
        },
        {
          type: "message",
          id: `a${index}`,
          parentId: `u${index}`,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: body,
            usage: index === 39 ? { input: 90_000, output: 20_000 } : undefined,
          },
        },
      );
    }
    seedTranscript({ sessionId, transcriptPath: sessionFile, events });

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokens: 1,
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(sessionsDir, "sessions.json"),
    });

    expect(tokens).toBe(110_000);
  });

  it("falls back to a conservative byte estimate when stale parent transcript has no usage", async () => {
    const root = await makeRoot("openclaw-parent-fork-byte-estimate-");
    useStateRoot(root);
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-no-usage-transcript";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    const events: unknown[] = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      },
    ];
    for (let index = 0; index < 24; index += 1) {
      events.push({
        type: "message",
        id: `u${index}`,
        parentId: index === 0 ? null : `a${index - 1}`,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: `turn-${index} ${"x".repeat(24_000)}` },
      });
    }
    seedTranscript({ sessionId, transcriptPath: sessionFile, events });

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(sessionsDir, "sessions.json"),
    });

    expect(tokens).toBeGreaterThan(100_000);
  });

  it("uses the latest usage snapshot instead of tail aggregates for parent fork checks", async () => {
    const root = await makeRoot("openclaw-parent-fork-latest-usage-");
    useStateRoot(root);
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-multiple-usage-transcript";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    seedTranscript({
      sessionId,
      transcriptPath: sessionFile,
      events: [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        },
        {
          message: {
            role: "assistant",
            content: "older",
            usage: { input: 60_000, output: 5_000 },
          },
        },
        {
          message: {
            role: "assistant",
            content: "latest",
            usage: { input: 70_000, output: 8_000 },
          },
        },
      ],
    });

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(sessionsDir, "sessions.json"),
    });

    expect(tokens).toBe(78_000);
  });

  it("keeps parent fork checks conservative for content appended after latest usage", async () => {
    const root = await makeRoot("openclaw-parent-fork-post-usage-tail-");
    useStateRoot(root);
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const sessionId = "parent-post-usage-tail";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    seedTranscript({
      sessionId,
      transcriptPath: sessionFile,
      events: [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        },
        {
          message: {
            role: "assistant",
            content: "latest model call",
            usage: { input: 40_000, output: 2_000 },
          },
        },
        {
          message: {
            role: "tool",
            content: `large appended tool result ${"x".repeat(450_000)}`,
          },
        },
      ],
    });

    const entry: SessionEntry = {
      sessionId,
      sessionFile,
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    const tokens = await resolveParentForkTokenCountRuntime({
      parentEntry: entry,
      storePath: path.join(sessionsDir, "sessions.json"),
    });

    expect(tokens).toBeGreaterThan(100_000);
  });
});

describe("forkSessionFromParentRuntime", () => {
  it("forks the active branch without synchronously opening the session manager", async () => {
    const root = await makeRoot("openclaw-parent-fork-");
    useStateRoot(root);
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, `${parentSessionId}.jsonl`);
    const events = [
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
    seedTranscript({ sessionId: parentSessionId, transcriptPath: parentSessionFile, events });

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (fork === null) {
      throw new Error("Expected forked session");
    }
    expect(fork.sessionFile).toContain(sessionsDir);
    expect(fork.sessionId).not.toBe(parentSessionId);
    const forkedEntries = readTranscript("main", fork.sessionId) as Array<Record<string, unknown>>;
    const resolvedParentSessionFile = path.join(
      await fs.realpath(sessionsDir),
      `${parentSessionId}.jsonl`,
    );
    expect(forkedEntries[0]).toMatchObject({
      type: "session",
      id: fork.sessionId,
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
    useStateRoot(root);
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);
    const parentSessionId = "parent-empty";
    const parentSessionFile = path.join(sessionsDir, `${parentSessionId}.jsonl`);
    seedTranscript({
      sessionId: parentSessionId,
      transcriptPath: parentSessionFile,
      events: [
        {
          type: "session",
          version: 3,
          id: parentSessionId,
          timestamp: "2026-05-01T00:00:00.000Z",
          cwd: root,
        },
      ],
    });

    const fork = await forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      agentId: "main",
      sessionsDir,
    });

    if (!fork) {
      throw new Error("expected forked session entry");
    }
    const entries = readTranscript("main", fork.sessionId) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    const resolvedParentSessionFile = path.join(
      await fs.realpath(sessionsDir),
      `${parentSessionId}.jsonl`,
    );
    expect(entries[0]).toMatchObject({
      type: "session",
      id: fork.sessionId,
      parentSession: resolvedParentSessionFile,
    });
  });
});
