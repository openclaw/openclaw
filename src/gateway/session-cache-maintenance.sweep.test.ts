import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";

const ONE_HOUR_MS = 60 * 60_000;
const { compactEmbeddedPiSessionMock, isEmbeddedPiRunActiveMock } = vi.hoisted(() => ({
  compactEmbeddedPiSessionMock: vi.fn(),
  isEmbeddedPiRunActiveMock: vi.fn(() => false),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  compactEmbeddedPiSession: compactEmbeddedPiSessionMock,
  isEmbeddedPiRunActive: isEmbeddedPiRunActiveMock,
}));

vi.mock("../agents/pi-embedded-runner/cache-ttl.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/pi-embedded-runner/cache-ttl.js")>(
    "../agents/pi-embedded-runner/cache-ttl.js",
  );
  return {
    ...actual,
    resolveCacheTtlMs: vi.fn(() => ONE_HOUR_MS),
    resolveTimeBasedContextCompactMode: vi.fn(() => "compact"),
  };
});

describe("runSessionCacheMaintenanceSweep", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    compactEmbeddedPiSessionMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReturnValue(false);
    await Promise.all(
      tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("retries idle compaction when the previous sweep did not compact", async () => {
    const { runSessionCacheMaintenanceSweep } = await import("./session-cache-maintenance.js");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cache-maint-"));
    tempRoots.push(root);
    const storePath = path.join(root, "sessions.json");
    const sessionFile = path.join(root, "session.jsonl");
    const sessionKey = "agent:main:test:compact-retry";
    const cacheTouchAt = 5_000;
    const now = cacheTouchAt + ONE_HOUR_MS - 60_000;

    await fs.writeFile(sessionFile, "", "utf-8");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sess-compact-retry",
          sessionFile,
          updatedAt: cacheTouchAt,
          lastUserMessageAt: cacheTouchAt,
          lastAssistantMessageAt: cacheTouchAt,
          lastCacheTouchAt: cacheTouchAt,
          totalTokens: 25_000,
          totalTokensFresh: true,
        },
      }),
      "utf-8",
    );

    compactEmbeddedPiSessionMock.mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "nothing to compact",
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await runSessionCacheMaintenanceSweep({
      cfg,
      nowMs: () => now,
    });
    await runSessionCacheMaintenanceSweep({
      cfg,
      nowMs: () => now,
    });

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledTimes(2);
    const stored = loadSessionStore(storePath, { skipCache: true });
    expect(stored[sessionKey]?.lastIdleCompactionForAssistantMessageAt).toBeUndefined();
  });

  it("does not compact twice during the same assistant idle window", async () => {
    const { runSessionCacheMaintenanceSweep } = await import("./session-cache-maintenance.js");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cache-once-"));
    tempRoots.push(root);
    const storePath = path.join(root, "sessions.json");
    const sessionFile = path.join(root, "session.jsonl");
    const sessionKey = "agent:main:test:compact-once";
    const assistantReplyAt = 5_000;
    const firstNow = assistantReplyAt + ONE_HOUR_MS - 60_000;
    const secondNow = firstNow + ONE_HOUR_MS - 60_000;

    await fs.writeFile(sessionFile, "", "utf-8");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sess-compact-once",
          sessionFile,
          updatedAt: assistantReplyAt,
          lastUserMessageAt: assistantReplyAt,
          lastAssistantMessageAt: assistantReplyAt,
          lastCacheTouchAt: assistantReplyAt,
          totalTokens: 25_000,
          totalTokensFresh: true,
        },
      }),
      "utf-8",
    );

    compactEmbeddedPiSessionMock.mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 10_000 },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await runSessionCacheMaintenanceSweep({
      cfg,
      nowMs: () => firstNow,
    });
    await runSessionCacheMaintenanceSweep({
      cfg,
      nowMs: () => secondNow,
    });

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledTimes(1);
    const stored = loadSessionStore(storePath, { skipCache: true });
    expect(stored[sessionKey]?.lastIdleCompactionForAssistantMessageAt).toBe(assistantReplyAt);
  });
});
