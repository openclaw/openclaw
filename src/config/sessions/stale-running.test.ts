import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore } from "./store.js";
import { reconcileStaleRunningSessions } from "./stale-running.js";
import type { SessionEntry } from "./types.js";

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-running-"));
  storePath = path.join(tmpDir, "sessions.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeStore(entries: Record<string, SessionEntry>) {
  await fs.writeFile(storePath, JSON.stringify(entries, null, 2), "utf-8");
}

async function writeTranscript(sessionId: string, messages: unknown[]) {
  await fs.writeFile(
    path.join(tmpDir, `${sessionId}.jsonl`),
    `${messages.map((message) => JSON.stringify({ message })).join("\n")}\n`,
    "utf-8",
  );
}

describe("reconcileStaleRunningSessions", () => {
  it("clears status=running when no active run or running task remains", async () => {
    const now = Date.now();
    await writeTranscript("sess-stale", [{ role: "assistant", content: "done" }]);
    await writeStore({
      "agent:openclaw:telegram:group:-1003789377335:topic:2": {
        sessionId: "sess-stale",
        updatedAt: now - 10 * 60_000,
        startedAt: now - 20 * 60_000,
        status: "running",
      },
    });

    const result = await reconcileStaleRunningSessions({
      storePath,
      activeRunSessionKeys: [],
      activeTasks: [],
      now,
    });

    expect(result.repaired).toHaveLength(1);
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store["agent:openclaw:telegram:group:-1003789377335:topic:2"];
    expect(entry?.status).toBe("done");
    expect(entry?.endedAt).toBe(now);
    expect(entry?.runtimeMs).toBe(20 * 60_000);
    expect(entry?.abortedLastRun).toBe(false);
  });

  it("marks stale no-progress running rows as lost with abort metadata", async () => {
    const now = Date.now();
    await writeStore({
      "agent:openclaw:telegram:group:-1003789377335:topic:2": {
        sessionId: "sess-lost",
        updatedAt: now - 10 * 60_000,
        status: "running",
      },
    });

    await reconcileStaleRunningSessions({
      storePath,
      activeRunSessionKeys: [],
      activeTasks: [],
      now,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:openclaw:telegram:group:-1003789377335:topic:2"]?.status).toBe("lost");
    expect(store["agent:openclaw:telegram:group:-1003789377335:topic:2"]?.abortedLastRun).toBe(
      true,
    );
  });

  it("does not close a real active run", async () => {
    const now = Date.now();
    await writeStore({
      "agent:openclaw:telegram:group:-1003789377335:topic:2": {
        sessionId: "sess-active",
        updatedAt: now - 10 * 60_000,
        status: "running",
      },
    });

    const result = await reconcileStaleRunningSessions({
      storePath,
      activeRunSessionKeys: ["agent:openclaw:telegram:group:-1003789377335:topic:2"],
      activeTasks: [],
      now,
    });

    expect(result.repaired).toHaveLength(0);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:openclaw:telegram:group:-1003789377335:topic:2"]?.status).toBe("running");
  });

  it("does not close a session with a running task for the session key", async () => {
    const now = Date.now();
    await writeStore({
      "agent:openclaw:telegram:group:-1003789377335:topic:2": {
        sessionId: "sess-task",
        updatedAt: now - 10 * 60_000,
        status: "running",
      },
    });

    const result = await reconcileStaleRunningSessions({
      storePath,
      activeRunSessionKeys: [],
      activeTasks: [
        {
          status: "running",
          ownerKey: "agent:openclaw:telegram:group:-1003789377335:topic:2",
        },
      ],
      now,
    });

    expect(result.repaired).toHaveLength(0);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:openclaw:telegram:group:-1003789377335:topic:2"]?.status).toBe("running");
  });

  it("preserves Telegram topic delivery context and thread id", async () => {
    const now = Date.now();
    await writeTranscript("sess-topic", [{ role: "assistant", content: "done" }]);
    await writeStore({
      "agent:openclaw:telegram:group:-1003789377335:topic:2": {
        sessionId: "sess-topic",
        updatedAt: now - 10 * 60_000,
        status: "running",
        deliveryContext: {
          channel: "telegram",
          to: "-1003789377335",
          threadId: 2,
        },
        lastThreadId: 2,
      },
    });

    await reconcileStaleRunningSessions({
      storePath,
      activeRunSessionKeys: [],
      activeTasks: [],
      now,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:openclaw:telegram:group:-1003789377335:topic:2"]).toMatchObject({
      status: "done",
      deliveryContext: {
        channel: "telegram",
        to: "-1003789377335",
        threadId: 2,
      },
      lastThreadId: 2,
    });
  });
});
