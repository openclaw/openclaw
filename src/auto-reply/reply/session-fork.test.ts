// Tests parent-session fork facade storage-boundary behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { forkSessionEntryFromParent } from "./session-fork.js";

const runtimeMocks = vi.hoisted(() => ({
  resolveParentForkTokenCountRuntime: vi.fn(),
}));

vi.mock("./session-fork.runtime.js", () => runtimeMocks);

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  // realpath first: macOS tmpdir is a /var -> /private/var symlink and the
  // fork resolver returns canonical paths.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(async () => {
  runtimeMocks.resolveParentForkTokenCountRuntime.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
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
