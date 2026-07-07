// Tests parent-session fork facade storage-boundary behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { forkSessionEntryFromParent, resolveParentForkDecision } from "./session-fork.js";

const runtimeMocks = vi.hoisted(() => ({
  forkSessionFromParentRuntime: vi.fn(),
  resolveParentForkTokenCountRuntime: vi.fn(),
}));

vi.mock("./session-fork.runtime.js", () => runtimeMocks);

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  runtimeMocks.forkSessionFromParentRuntime.mockReset();
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
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [parentSessionKey]: {
            sessionId: "parent-session",
            sessionFile: path.join(activeStoreDir, "parent.jsonl"),
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
    runtimeMocks.forkSessionFromParentRuntime.mockImplementation(
      async ({ sessionsDir }: { sessionsDir: string }) => ({
        sessionId: "forked-session",
        sessionFile: path.join(sessionsDir, "forked-session.jsonl"),
      }),
    );

    const result = await forkSessionEntryFromParent({
      agentId: "main",
      config: { session: { store: configStorePath } } as OpenClawConfig,
      fallbackEntry: { sessionId: "", updatedAt: 2 },
      parentSessionKey,
      sessionKey,
      storePath,
    });

    expect(result.status).toBe("forked");
    expect(runtimeMocks.forkSessionFromParentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsDir: activeStoreDir,
      }),
    );
    const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { sessionFile?: string }
    >;
    expect(stored[sessionKey]?.sessionFile).toBe(path.join(activeStoreDir, "forked-session.jsonl"));
  });
});

describe("resolveParentForkDecision", () => {
  it("returns fork with parentTokens when the runtime resolves quickly", async () => {
    runtimeMocks.resolveParentForkTokenCountRuntime.mockResolvedValue(50_000);

    const decision = await resolveParentForkDecision({
      parentEntry: { sessionId: "parent", updatedAt: 1 },
      agentId: "main",
      storePath: "/tmp/sessions.json",
    });

    expect(decision.status).toBe("fork");
    expect(decision).toHaveProperty("parentTokens", 50_000);
  });

  it("returns fork without parentTokens when the runtime hangs (timeout protection)", async () => {
    // Simulate a hung filesystem runtime that never resolves.
    runtimeMocks.resolveParentForkTokenCountRuntime.mockReturnValue(new Promise<number>(() => {}));

    const decision = await resolveParentForkDecision({
      parentEntry: { sessionId: "parent", updatedAt: 1 },
      agentId: "main",
      storePath: "/tmp/sessions.json",
    });

    // Must still return a decision (not throw/timeout the caller).
    // Fork proceeds without a token estimate rather than blocking (#101718).
    expect(decision.status).toBe("fork");
    expect(decision).not.toHaveProperty("parentTokens");
  });

  it("returns skip when parent is too large", async () => {
    runtimeMocks.resolveParentForkTokenCountRuntime.mockResolvedValue(200_000);

    const decision = await resolveParentForkDecision({
      parentEntry: { sessionId: "parent", updatedAt: 1 },
      agentId: "main",
      storePath: "/tmp/sessions.json",
    });

    expect(decision.status).toBe("skip");
    expect(decision.reason).toBe("parent-too-large");
    expect(decision.parentTokens).toBe(200_000);
    expect(decision.maxTokens).toBe(100_000);
  });
});
