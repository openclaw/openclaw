import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

const beginGate = vi.hoisted(() => {
  const createDeferredLocal = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    return { promise, resolve, reject };
  };
  return {
    started: createDeferredLocal<void>(),
    release: createDeferredLocal<void>(),
  };
});

const sqlUnsafe = vi.fn(async () => []);
const sqlBegin = vi.fn(async (callback: (tx: { unsafe: typeof sqlUnsafe }) => Promise<unknown>) => {
  beginGate.started.resolve();
  await beginGate.release.promise;
  return await callback({ unsafe: sqlUnsafe });
});

vi.mock("./postgres-client.js", () => ({
  getPostgresPersistenceWithMode: vi.fn(async () => ({
    schemaSql: '"openclaw_test"',
    sql: {
      begin: sqlBegin,
      unsafe: sqlUnsafe,
    },
  })),
  isPostgresPersistenceEnabled: () => true,
}));

const { syncSessionManagerToPostgres } = await import("./service.js");

describe("transcript persistence serialization", () => {
  let tempDir = "";

  afterEach(async () => {
    sqlBegin.mockClear();
    sqlUnsafe.mockClear();
    beginGate.started = createDeferred<void>();
    beginGate.release = createDeferred<void>();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("serializes same-transcript syncs so a later snapshot waits for the earlier one", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-persistence-transcript-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: new Date().toISOString(),
        cwd: tempDir,
      })}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage({
      role: "user",
      content: "first",
      timestamp: Date.now(),
    });

    const firstSync = syncSessionManagerToPostgres({
      sessionManager,
      transcriptPath: sessionFile,
      sessionId: "session-1",
    });
    await beginGate.started.promise;

    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
      api: "openai-responses",
      provider: "openclaw",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
    });

    const secondSync = syncSessionManagerToPostgres({
      sessionManager,
      transcriptPath: sessionFile,
      sessionId: "session-1",
    });

    await Promise.resolve();
    expect(sqlBegin).toHaveBeenCalledTimes(1);

    beginGate.release.resolve();
    await Promise.all([firstSync, secondSync]);
    expect(sqlBegin).toHaveBeenCalledTimes(2);
  });
});
