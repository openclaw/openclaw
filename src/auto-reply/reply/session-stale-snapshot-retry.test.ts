/**
 * Tests for stale-snapshot retry with exponential backoff during concurrent
 * reply-session initialization (#100173).
 *
 * Cross-process session-store conflicts cannot be reproduced in a single
 * Vitest worker because all same-store writes serialize through the in-process
 * writer queue. These tests mock commitReplySessionInitialization to return
 * synthetic stale-snapshot results and verify the retry contract.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { writeSessionStoreForTestAsync } from "../../config/sessions/test-helpers.js";
import { initSessionState } from "./session.js";

const commitMock = vi.fn();

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual("../../config/sessions/session-accessor.js");
  return {
    ...(actual as Record<string, unknown>),
    commitReplySessionInitialization: (
      ...args: Parameters<typeof commitMock>
    ): ReturnType<typeof commitMock> => commitMock(...args),
  };
});

let suiteRoot: string;
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-retry-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

async function makeStorePath(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return path.join(dir, "sessions.json");
}

async function setupSession(storePath: string, sessionKey: string) {
  await writeSessionStoreForTestAsync(storePath, {
    [sessionKey]: {
      sessionId: "existing-session",
      updatedAt: Date.now(),
    },
  });
}

describe("initSessionState stale-snapshot retry", () => {
  beforeEach(() => {
    commitMock.mockReset();
  });

  it("retries with backoff and succeeds after transient stale-snapshot conflicts", async () => {
    const storePath = await makeStorePath("ok-");
    const sessionKey = "agent:main:telegram:chat:retry-ok";
    await setupSession(storePath, sessionKey);
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    let callCount = 0;
    commitMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 2) {
        return { ok: false as const, reason: "stale-snapshot" as const, revision: "stale" };
      }
      return {
        ok: true as const,
        previousSessionTranscript: { transcriptFile: null, tokenCount: null, endedAt: null },
        sessionEntry: {
          sessionId: "backoff-session",
          sessionKey,
          updatedAt: Date.now(),
          revision: "latest",
        },
        sessionStoreView: {},
      };
    });

    const result = await initSessionState({
      ctx: { Body: "retry me", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    // 1 initial + 2 stale retries + 1 success = 4 calls
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(result.sessionKey).toBe(sessionKey);
    expect(result.sessionEntry.sessionId).toBe("backoff-session");
  });

  it("throws after exhausting all 4 attempts (1 initial + 3 retries)", async () => {
    const storePath = await makeStorePath("exhaust-");
    const sessionKey = "agent:main:telegram:chat:exhaust";
    await setupSession(storePath, sessionKey);
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    commitMock.mockImplementation(async () => ({
      ok: false as const,
      reason: "stale-snapshot" as const,
      revision: "stale",
    }));

    await expect(
      initSessionState({
        ctx: { Body: "keep failing", SessionKey: sessionKey },
        cfg,
        commandAuthorized: true,
      }),
    ).rejects.toThrow(`reply session initialization conflicted for ${sessionKey}`);

    // 1 initial + 3 retries = 4 attempts
    expect(commitMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-stale-snapshot errors", async () => {
    const storePath = await makeStorePath("nonretry-");
    const sessionKey = "agent:main:telegram:chat:nonretry";
    await setupSession(storePath, sessionKey);
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    commitMock.mockRejectedValue(new Error("unrelated disk error"));

    await expect(
      initSessionState({
        ctx: { Body: "boom", SessionKey: sessionKey },
        cfg,
        commandAuthorized: true,
      }),
    ).rejects.toThrow("unrelated disk error");

    // Must not retry — only 1 attempt
    expect(commitMock).toHaveBeenCalledTimes(1);
  });
});
