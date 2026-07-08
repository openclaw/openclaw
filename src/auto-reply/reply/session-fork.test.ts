// Tests parent-session fork facade storage-boundary behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { forkSessionEntryFromParent, resolveParentForkDecision } from "./session-fork.js";

const runtimeMocks = vi.hoisted(() => ({
  resolveParentForkTokenCountRuntime: vi.fn(),
}));

vi.mock("./session-fork.runtime.js", () => runtimeMocks);

const roots: string[] = [];
const parentTooLargeMessage =
  "Parent context is too large to fork (170000/100000 tokens); starting with isolated context instead.";

async function makeRoot(prefix: string): Promise<string> {
  // realpath first: macOS tmpdir is a /var -> /private/var symlink and the
  // fork resolver returns canonical paths.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  runtimeMocks.resolveParentForkTokenCountRuntime.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveParentForkDecision", () => {
  it("uses fresh parent token counts without transcript probing", async () => {
    runtimeMocks.resolveParentForkTokenCountRuntime.mockReturnValue(new Promise(() => {}));

    await expect(
      resolveParentForkDecision({
        parentEntry: {
          sessionId: "parent-session",
          updatedAt: 1,
          totalTokens: 170_000,
          totalTokensFresh: true,
        },
        storePath: path.join(os.tmpdir(), "sessions.json"),
      }),
    ).resolves.toEqual({
      status: "skip",
      reason: "parent-too-large",
      maxTokens: 100_000,
      parentTokens: 170_000,
      message: parentTooLargeMessage,
    });
    expect(runtimeMocks.resolveParentForkTokenCountRuntime).not.toHaveBeenCalled();
  });

  it("continues with a fork decision when parent token probing stalls", async () => {
    vi.useFakeTimers();
    runtimeMocks.resolveParentForkTokenCountRuntime.mockReturnValue(new Promise(() => {}));

    const decision = resolveParentForkDecision({
      parentEntry: { sessionId: "parent-session", updatedAt: 1 },
      storePath: path.join(os.tmpdir(), "sessions.json"),
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(decision).resolves.toEqual({
      status: "fork",
      maxTokens: 100_000,
    });
  });

  it("still skips quickly resolved oversized parent sessions", async () => {
    runtimeMocks.resolveParentForkTokenCountRuntime.mockResolvedValue(170_000);

    await expect(
      resolveParentForkDecision({
        parentEntry: { sessionId: "parent-session", updatedAt: 1 },
        storePath: path.join(os.tmpdir(), "sessions.json"),
      }),
    ).resolves.toEqual({
      status: "skip",
      reason: "parent-too-large",
      maxTokens: 100_000,
      parentTokens: 170_000,
      message: parentTooLargeMessage,
    });
  });
});

describe("forkSessionEntryFromParent", () => {
  it("forks transcripts in the directory for the store being mutated", async () => {
    const root = await makeRoot("openclaw-session-fork-boundary-");
    const activeStoreDir = path.join(root, "active-store");
    const configStoreDir = path.join(root, "config-store");
    await fs.mkdir(activeStoreDir, { recursive: true });
    await fs.mkdir(configStoreDir, { recursive: true });
    const storePath = path.join(activeStoreDir, "sessions.json");
    const configStorePath = path.join(configStoreDir, "sessions.json");
    const parentSessionKey = "agent:main:main";
    const sessionKey = "agent:main:subagent:child";
    const parentSessionFile = path.join(activeStoreDir, "parent.jsonl");
    await fs.writeFile(
      parentSessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "parent-session",
          timestamp: "2026-05-01T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: null,
          timestamp: "2026-05-01T00:00:01.000Z",
          message: { role: "assistant", content: "hi" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [parentSessionKey]: {
            sessionId: "parent-session",
            sessionFile: parentSessionFile,
            updatedAt: 1,
          },
          [sessionKey]: { sessionId: "", updatedAt: 2 },
        },
        null,
        2,
      ),
      "utf-8",
    );

    runtimeMocks.resolveParentForkTokenCountRuntime.mockResolvedValue(10);

    const result = await forkSessionEntryFromParent({
      agentId: "main",
      config: { session: { store: configStorePath } } as OpenClawConfig,
      fallbackEntry: { sessionId: "", updatedAt: 2 },
      parentSessionKey,
      sessionKey,
      storePath,
    });

    expect(result.status).toBe("forked");
    if (result.status !== "forked") {
      throw new Error("expected forked result");
    }
    // The fork artifact lands beside the store being mutated, not the config store.
    expect(path.dirname(result.fork.sessionFile)).toBe(activeStoreDir);
    const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string; sessionFile?: string }
    >;
    expect(stored[sessionKey]?.sessionId).toBe(result.fork.sessionId);
    expect(stored[sessionKey]?.sessionFile).toBe(result.fork.sessionFile);
  });
});
