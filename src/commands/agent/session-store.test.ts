import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

function acpMeta() {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
}

describe("updateSessionStoreAfterAgentRun", () => {
  it("preserves ACP metadata when caller has a stale session snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:acp:${randomUUID()}`;
    const sessionId = randomUUID();

    const existing: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      acp: acpMeta(),
    };
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: existing }, null, 2), "utf8");

    const staleInMemory: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore: staleInMemory,
      defaultProvider: "openai",
      defaultModel: "gpt-5.3-codex",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "openai",
            model: "gpt-5.3-codex",
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.acp).toBeDefined();
    expect(staleInMemory[sessionKey]?.acp).toBeDefined();
  });

  it("sanitizes negative usage before persisting session token fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:main:test:${randomUUID()}`;
    const sessionId = randomUUID();

    const sessionStore: Record<string, SessionEntry> = {};
    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "custom-provider",
      defaultModel: "claude-sonnet-4-6-thinking",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "custom-provider",
            model: "claude-sonnet-4-6-thinking",
            usage: {
              input: -79_714,
              output: 1_736,
              cacheRead: 111_131,
              cacheWrite: 0,
              total: 4_478,
            },
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.inputTokens).toBe(0);
    expect(persisted?.outputTokens).toBe(1736);
    expect(persisted?.cacheRead).toBe(111_131);
    expect(persisted?.cacheWrite).toBe(0);
    expect(persisted?.totalTokensFresh).toBe(true);
  });
});
