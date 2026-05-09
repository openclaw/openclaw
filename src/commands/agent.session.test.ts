import path from "node:path";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveSession } from "../agents/command/session.js";
import { upsertSessionEntry } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
      return await fn(home);
    },
    {
      prefix: "openclaw-agent-session-",
      skipStateCleanup: true,
    },
  );
}

function mockConfig(
  home: string,
  agentsList?: Array<{ id: string; default?: boolean }>,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
      },
      list: agentsList,
    },
    session: { mainKey: "main" },
  } as OpenClawConfig;
}

async function writeSessionRows(
  agentId: string,
  sessions: Record<string, Record<string, unknown>>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(sessions)) {
    upsertSessionEntry({ agentId, sessionKey, entry: entry as SessionEntry });
  }
}

async function withCrossAgentResumeFixture(
  run: (params: { sessionId: string; sessionKey: string; cfg: OpenClawConfig }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (home) => {
    const sessionId = "session-exec-hook";
    const sessionKey = "agent:exec:hook:gmail:thread-1";
    await writeSessionRows("exec", {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        systemSent: true,
      },
    });
    const cfg = mockConfig(home, [{ id: "dev" }, { id: "exec", default: true }]);
    await run({ sessionId, sessionKey, cfg });
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

describe("agent session resolution", () => {
  it("creates a stable session key for explicit session-id-only runs", async () => {
    await withTempHome(async (home) => {
      const cfg = mockConfig(home);

      const resolution = resolveSession({ cfg, sessionId: "explicit-session-123" });

      expect(resolution.sessionKey).toBe("agent:main:explicit:explicit-session-123");
      expect(resolution.sessionId).toBe("explicit-session-123");
    });
  });

  it("uses the resumed session agent scope when sessionId resolves to another agent store", async () => {
    await withCrossAgentResumeFixture(async ({ sessionId, sessionKey, cfg }) => {
      const resolution = resolveSession({ cfg, sessionId });
      expect(resolution.sessionKey).toBe(sessionKey);
      const agentId = resolveSessionAgentId({ sessionKey: resolution.sessionKey, config: cfg });
      expect(agentId).toBe("exec");
      expect(resolveAgentDir(cfg, agentId)).toContain(
        `${path.sep}agents${path.sep}exec${path.sep}agent`,
      );
    });
  });

  it("resolves duplicate cross-agent sessionIds deterministically", async () => {
    await withTempHome(async (home) => {
      await writeSessionRows("other", {
        "agent:other:main": {
          sessionId: "run-dup",
          updatedAt: Date.now() + 1_000,
        },
      });
      await writeSessionRows("retired", {
        "agent:retired:acp:run-dup": {
          sessionId: "run-dup",
          updatedAt: Date.now(),
        },
      });
      const cfg = mockConfig(home, [{ id: "other" }, { id: "retired", default: true }]);

      const resolution = resolveSession({ cfg, sessionId: "run-dup" });

      expect(resolution.sessionKey).toBe("agent:retired:acp:run-dup");
      expect(resolution.agentId).toBe("retired");
    });
  });

  it("uses origin.provider for channel-specific session reset overrides", async () => {
    await withTempHome(async (home) => {
      await writeSessionRows("main", {
        main: {
          sessionId: "origin-provider-reset",
          updatedAt: Date.now() - 30 * 60_000,
          origin: { provider: "quietchat" },
        },
      });
      const cfg = mockConfig(home);
      cfg.session = {
        ...cfg.session,
        reset: { mode: "idle", idleMinutes: 10 },
        resetByChannel: {
          quietchat: { mode: "idle", idleMinutes: 120 },
        },
      };

      const resolution = resolveSession({ cfg, sessionKey: "main" });

      expect(resolution.sessionId).toBe("origin-provider-reset");
      expect(resolution.isNewSession).toBe(false);
    });
  });

  it("forwards resolved outbound session context when resuming by sessionId", async () => {
    await withCrossAgentResumeFixture(async ({ sessionId, sessionKey, cfg }) => {
      const resolution = resolveSession({ cfg, sessionId });
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
