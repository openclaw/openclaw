import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveSession } from "../agents/command/session.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-session-" });
}

function mockConfig(
  home: string,
  storePath: string,
  agentEntries?: NonNullable<OpenClawConfig["agents"]>["entries"],
  systemAgentId?: string,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
        ...(systemAgentId ? { systemAgent: { agentId: systemAgentId } } : {}),
      },
      entries: agentEntries,
      ...(systemAgentId ? { ownership: "explicit" as const } : {}),
    },
    session: { store: storePath, mainKey: "main" },
  };
}

async function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, SessionEntry>,
): Promise<void> {
  await Promise.all(
    Object.entries(sessions).map(([sessionKey, entry]) =>
      replaceSessionEntry({ sessionKey, storePath }, entry),
    ),
  );
}

async function seedTerminalSession(home: string, mainKey: string, status?: SessionEntry["status"]) {
  const storePath = path.join(home, "sessions.json");
  const sessionKey = `agent:main:${mainKey}`;
  const sessionId = "stale-terminal-main";
  const updatedAt = Date.now() - 10_000;
  const entry: SessionEntry = {
    sessionId,
    sessionFile: path.join(home, "terminal-main.jsonl"),
    updatedAt,
    ...(status ? { status } : {}),
    sessionStartedAt: updatedAt - 60_000,
    lastInteractionAt: updatedAt - 30_000,
    startedAt: updatedAt - 1_000,
    endedAt: updatedAt - 100,
    runtimeMs: 900,
    cliSessionBindings: {
      "claude-cli": { sessionId: "old-claude-cli-session" },
      "codex-cli": { sessionId: "old-codex-cli-session" },
    },
    cliSessionIds: { "claude-cli": "old-claude-cli-session", "codex-cli": "old-codex-cli-session" },
    claudeCliSessionId: "old-claude-cli-session",
  };
  await replaceSessionEntry({ sessionKey, storePath }, entry);
  await appendTranscriptEvent(
    { agentId: "main", sessionId, sessionKey, storePath },
    { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
  );
  const cfg = mockConfig(home, storePath);
  cfg.session = { ...cfg.session, mainKey };
  return { cfg, sessionId, updatedAt };
}

async function withCrossAgentResumeFixture(
  run: (params: { sessionId: string; sessionKey: string; cfg: OpenClawConfig }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (home) => {
    const storePattern = path.join(home, "agents", "{agentId}", "sessions", "sessions.json");
    const execStore = path.join(home, "agents", "exec", "sessions", "sessions.json");
    const sessionId = "session-exec-hook";
    const sessionKey = "agent:exec:hook:gmail:thread-1";
    await writeSessionStoreSeed(execStore, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        systemSent: true,
      },
    });
    const cfg = mockConfig(home, storePattern, { dev: {}, exec: {} }, "exec");
    await run({ sessionId, sessionKey, cfg });
  });
}

beforeEach(() => {
  clearSessionStoreCacheForTest();
  // Keep freshness fixtures away from the local 04:00 daily-reset boundary.
  vi.useFakeTimers({ toFake: ["Date"] });
  const localNoon = new Date();
  localNoon.setHours(12, 0, 0, 0);
  vi.setSystemTime(localNoon);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agent session resolution", () => {
  it("creates a stable session key for explicit session-id-only runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const cfg = mockConfig(home, store);

      const resolution = await resolveSession({ cfg, sessionId: "explicit-session-123" });

      expect(resolution.sessionKey).toBe("agent:main:explicit:explicit-session-123");
      expect(resolution.sessionId).toBe("explicit-session-123");
    });
  });

  it.each(["main", "global", "unknown"])(
    "finds a session-id-only %s target in another explicit agent store",
    async (sessionKey) => {
      await withTempHome(async (home) => {
        const storePattern = path.join(home, "agents", "{agentId}", "sessions", "sessions.json");
        const researchStore = path.join(home, "agents", "research", "sessions", "sessions.json");
        const base = mockConfig(home, storePattern);
        const cfg = {
          ...base,
          agents: {
            ...base.agents,
            ownership: "explicit",
            entries: { ops: {}, research: {} },
          },
        } satisfies OpenClawConfig;
        await replaceSessionEntry(
          { agentId: "research", sessionKey, storePath: researchStore },
          { sessionId: "research-session", updatedAt: Date.now() },
        );

        const resolution = await resolveSession({ cfg, sessionId: "research-session" });

        expect(resolution.sessionId).toBe("research-session");
        expect(resolution.sessionAgentId).toBe("research");
        expect(resolution.sessionKey).toBe(
          sessionKey === "main" ? "agent:research:main" : sessionKey,
        );
        expect(resolution.storePath).toBe(researchStore);
      });
    },
  );

  it("resolves duplicate cross-agent sessionIds deterministically", async () => {
    await withTempHome(async (home) => {
      const storePattern = path.join(home, "agents", "{agentId}", "sessions", "sessions.json");
      const otherStore = path.join(home, "agents", "other", "sessions", "sessions.json");
      const retiredStore = path.join(home, "agents", "retired", "sessions", "sessions.json");
      await writeSessionStoreSeed(otherStore, {
        "agent:other:main": {
          sessionId: "run-dup",
          updatedAt: Date.now() + 1_000,
        },
      });
      await writeSessionStoreSeed(retiredStore, {
        "agent:retired:acp:run-dup": {
          sessionId: "run-dup",
          updatedAt: Date.now(),
        },
      });
      const cfg = mockConfig(home, storePattern, { other: {}, retired: {} }, "retired");

      const resolution = await resolveSession({ cfg, sessionId: "run-dup" });

      expect(resolution.sessionKey).toBe("agent:retired:acp:run-dup");
      expect(resolution.storePath).toBe(retiredStore);
    });
  });

  it("uses origin.provider for channel-specific session reset overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      await replaceSessionEntry(
        { storePath: store, sessionKey: "agent:main:main" },
        {
          sessionId: "origin-provider-reset",
          updatedAt: Date.now() - 30 * 60_000,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "quietchat" },
            origin: { provider: "quietchat" },
          }),
        },
      );
      const cfg = mockConfig(home, store);
      cfg.session = {
        ...cfg.session,
        reset: { mode: "idle", idleMinutes: 10 },
        resetByChannel: {
          quietchat: { mode: "idle", idleMinutes: 120 },
        },
      };

      const resolution = await resolveSession({ cfg, sessionKey: "main" });

      expect(resolution).toMatchObject({ sessionId: "origin-provider-reset", isNewSession: false });
    });
  });

  it.each<[string, SessionEntry["status"], string?, string?]>([
    ["canonical done main", "done"],
    ["raw done main alias", "done", "main", "main"],
    ["custom done main alias", "done", "work"],
    ["killed main", "killed"],
    ["endedAt-only main", undefined],
  ])(
    "uses explicit outcomes for %s with a newer transcript",
    async (label, status, mainKey = "main", requestedSessionKey = "agent:main:main") => {
      const storedSessionKey = `agent:main:${mainKey}`;
      const expectNewSession = status === "killed";
      await withTempHome(async (home) => {
        const { cfg, sessionId, updatedAt } = await seedTerminalSession(home, mainKey, status);

        const resolution = await resolveSession({ cfg, sessionKey: requestedSessionKey });

        expect(resolution, label).toMatchObject({
          sessionKey: storedSessionKey,
          isNewSession: expectNewSession,
        });
        if (!expectNewSession) {
          expect(resolution.sessionId).toBe(sessionId);
          expect(resolution.sessionEntry?.status).toBe(status);
          if (status === undefined) {
            expect(resolution.sessionEntry?.endedAt).toBe(updatedAt - 100);
          }
          return;
        }
        expect(resolution.sessionId).not.toBe(sessionId);
        for (const key of [
          "sessionFile",
          "status",
          "startedAt",
          "endedAt",
          "runtimeMs",
          "sessionStartedAt",
          "lastInteractionAt",
          "cliSessionBindings",
          "cliSessionIds",
          "claudeCliSessionId",
        ] as const) {
          expect(resolution.sessionEntry?.[key], key).toBeUndefined();
        }
      });
    },
  );

  it("preserves explicit session-id resumes for stale terminal main rows", async () => {
    await withTempHome(async (home) => {
      const { cfg, sessionId, updatedAt } = await seedTerminalSession(home, "main", "done");

      const resolution = await resolveSession({ cfg, sessionId });

      expect(resolution).toMatchObject({
        sessionKey: "agent:main:main",
        sessionId,
        isNewSession: false,
      });
      const persisted = loadSessionEntry({
        sessionKey: expectDefined(resolution.sessionKey, "resolved session key"),
        storePath: resolution.storePath,
      });
      for (const entry of [resolution.sessionEntry, persisted]) {
        expect(entry).not.toHaveProperty("sessionFile");
        expect(entry).toMatchObject({
          sessionId,
          status: "done",
          startedAt: updatedAt - 1_000,
          endedAt: updatedAt - 100,
          runtimeMs: 900,
        });
      }
    });
  });

  it("forwards resolved outbound session context when resuming by sessionId", async () => {
    await withCrossAgentResumeFixture(async ({ sessionId, sessionKey, cfg }) => {
      const resolution = await resolveSession({ cfg, sessionId });
      expect(resolution.sessionKey).toBe(sessionKey);
      const agentId = resolveSessionAgentId({ sessionKey: resolution.sessionKey, config: cfg });
      const outboundContext = buildOutboundSessionContext({
        cfg,
        sessionKey: resolution.sessionKey,
        agentId,
      });
      if (!outboundContext) {
        throw new Error("expected outbound session context");
      }
      expect(outboundContext.key).toBe(sessionKey);
      expect(outboundContext.agentId).toBe("exec");
    });
  });
});
