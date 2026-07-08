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
  estimateParentForkTokensFromSizeRuntime: vi.fn(),
}));

vi.mock("./session-fork.runtime.js", () => runtimeMocks);

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A promise that never settles, used to model a hung filesystem read. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const decisionParams = {
  parentEntry: { sessionId: "parent", updatedAt: 1 },
  agentId: "main",
  storePath: "/tmp/sessions.json",
} as const;

afterEach(async () => {
  vi.useRealTimers();
  runtimeMocks.forkSessionFromParentRuntime.mockReset();
  runtimeMocks.resolveParentForkTokenCountRuntime.mockReset();
  runtimeMocks.estimateParentForkTokensFromSizeRuntime.mockReset();
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

  it("skips the fork read entirely when the parent size cannot be resolved (#101718)", async () => {
    const root = await makeRoot("openclaw-session-fork-timeout-");
    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:main";
    const sessionKey = "agent:main:subagent:child";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [parentSessionKey]: {
          sessionId: "parent-session",
          sessionFile: path.join(root, "parent.jsonl"),
          updatedAt: 1,
        },
        [sessionKey]: { sessionId: "", updatedAt: 2 },
      }),
      "utf-8",
    );

    vi.useFakeTimers();
    // Both the full resolution and the fast size probe hang: the parent size is
    // unresolvable. The fork must NOT proceed into the unbounded transcript read.
    runtimeMocks.resolveParentForkTokenCountRuntime.mockReturnValue(neverSettles());
    runtimeMocks.estimateParentForkTokensFromSizeRuntime.mockReturnValue(neverSettles());

    const resultPromise = forkSessionEntryFromParent({
      agentId: "main",
      fallbackEntry: { sessionId: "", updatedAt: 2 },
      parentSessionKey,
      sessionKey,
      storePath,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await resultPromise;

    expect(result.status).toBe("skipped");
    expect(runtimeMocks.forkSessionFromParentRuntime).not.toHaveBeenCalled();
  });
});

describe("resolveParentForkDecision", () => {
  it("returns fork with token count when the runtime resolves quickly", async () => {
    runtimeMocks.resolveParentForkTokenCountRuntime.mockResolvedValue(50_000);

    const decision = await resolveParentForkDecision({ ...decisionParams });

    expect(decision.status).toBe("fork");
    if (decision.status !== "fork") {
      throw new Error("expected fork");
    }
    expect(decision.parentTokens).toBe(50_000);
    expect(runtimeMocks.estimateParentForkTokensFromSizeRuntime).not.toHaveBeenCalled();
  });

  it("returns skip when parent is too large", async () => {
    runtimeMocks.resolveParentForkTokenCountRuntime.mockResolvedValue(200_000);

    const decision = await resolveParentForkDecision({ ...decisionParams });

    expect(decision.status).toBe("skip");
    if (decision.status !== "skip") {
      throw new Error("expected skip");
    }
    expect(decision.reason).toBe("parent-too-large");
    if (decision.reason !== "parent-too-large") {
      throw new Error("expected parent-too-large");
    }
    expect(decision.parentTokens).toBe(200_000);
    expect(decision.maxTokens).toBe(100_000);
  });

  it("falls back to the byte estimate and forks a small parent when the runtime hangs", async () => {
    vi.useFakeTimers();
    runtimeMocks.resolveParentForkTokenCountRuntime.mockReturnValue(neverSettles());
    runtimeMocks.estimateParentForkTokensFromSizeRuntime.mockResolvedValue(40_000);

    const decisionPromise = resolveParentForkDecision({ ...decisionParams });
    await vi.advanceTimersByTimeAsync(2_500);
    const decision = await decisionPromise;

    expect(decision.status).toBe("fork");
    if (decision.status !== "fork") {
      throw new Error("expected fork");
    }
    // The conservative estimate is preserved rather than discarded on timeout.
    expect(decision.parentTokens).toBe(40_000);
    expect(runtimeMocks.estimateParentForkTokensFromSizeRuntime).toHaveBeenCalledTimes(1);
  });

  it("falls back to the byte estimate and skips an oversized parent when the runtime hangs", async () => {
    vi.useFakeTimers();
    runtimeMocks.resolveParentForkTokenCountRuntime.mockReturnValue(neverSettles());
    runtimeMocks.estimateParentForkTokensFromSizeRuntime.mockResolvedValue(5_000_000);

    const decisionPromise = resolveParentForkDecision({ ...decisionParams });
    await vi.advanceTimersByTimeAsync(2_500);
    const decision = await decisionPromise;

    expect(decision.status).toBe("skip");
    if (decision.status !== "skip") {
      throw new Error("expected skip");
    }
    expect(decision.reason).toBe("parent-too-large");
    if (decision.reason !== "parent-too-large") {
      throw new Error("expected parent-too-large");
    }
    expect(decision.parentTokens).toBe(5_000_000);
  });

  it("skips with an unresolved reason when both the runtime and the size probe hang", async () => {
    vi.useFakeTimers();
    runtimeMocks.resolveParentForkTokenCountRuntime.mockReturnValue(neverSettles());
    runtimeMocks.estimateParentForkTokensFromSizeRuntime.mockReturnValue(neverSettles());

    const decisionPromise = resolveParentForkDecision({ ...decisionParams });
    await vi.advanceTimersByTimeAsync(4_000);
    const decision = await decisionPromise;

    expect(decision.status).toBe("skip");
    if (decision.status !== "skip") {
      throw new Error("expected skip");
    }
    expect(decision.reason).toBe("parent-size-unresolved");
    expect(decision.message.length).toBeGreaterThan(0);
  });
});
