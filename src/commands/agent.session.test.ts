// Agent session command tests cover session resolution, agent scoping, and temp-home session stores.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSession } from "../agents/command/session.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, {
    prefix: "openclaw-agent-session-",
  });
}

function mockConfig(home: string, storePath: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
      },
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

beforeEach(() => {
  clearSessionStoreCacheForTest();
  // Freshness fixtures seed times relative to Date.now(); near the 04:00
  // local daily-reset boundary the seeded window straddles it and reuse
  // scenarios flip to new sessions. Pin local noon so no timezone can hit it.
  vi.useFakeTimers({ toFake: ["Date"] });
  const localNoon = new Date();
  localNoon.setHours(12, 0, 0, 0);
  vi.setSystemTime(localNoon);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agent session resolution", () => {
  it("uses origin.provider for channel-specific session reset overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      await writeSessionStoreSeed(store, {
        "agent:main:main": {
          sessionId: "origin-provider-reset",
          updatedAt: Date.now() - 30 * 60_000,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "quietchat" },
            origin: { provider: "quietchat" },
          }),
        },
      });
      const cfg = mockConfig(home, store);
      cfg.session = {
        ...cfg.session,
        reset: { mode: "idle", idleMinutes: 10 },
        resetByChannel: {
          quietchat: { mode: "idle", idleMinutes: 120 },
        },
      };

      const resolution = await resolveSession({ cfg, sessionKey: "main" });

      expect(resolution.sessionId).toBe("origin-provider-reset");
      expect(resolution.isNewSession).toBe(false);
    });
  });

  it("uses explicit outcomes when a main transcript is newer than the registry", async () => {
    const scenarios = [
      {
        label: "canonical done main",
        mainKey: "main",
        requestedSessionKey: "agent:main:main",
        storedSessionKey: "agent:main:main",
        status: "done" as const,
        expectNewSession: false,
      },
      {
        label: "raw done main alias",
        mainKey: "main",
        requestedSessionKey: "main",
        storedSessionKey: "agent:main:main",
        status: "done" as const,
        expectNewSession: false,
      },
      {
        label: "custom done main alias",
        mainKey: "work",
        requestedSessionKey: "agent:main:main",
        storedSessionKey: "agent:main:work",
        status: "done" as const,
        expectNewSession: false,
      },
      {
        label: "killed main",
        mainKey: "main",
        requestedSessionKey: "agent:main:main",
        storedSessionKey: "agent:main:main",
        status: "killed" as const,
        expectNewSession: true,
      },
      {
        label: "endedAt-only main",
        mainKey: "main",
        requestedSessionKey: "agent:main:main",
        storedSessionKey: "agent:main:main",
        status: undefined,
        expectNewSession: false,
      },
    ] as const;
    for (const scenario of scenarios) {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        const sessionFile = path.join(home, `session-${scenario.label.replaceAll(" ", "-")}.jsonl`);
        const sessionId = `stale-terminal-${scenario.label.replaceAll(" ", "-")}`;
        const registryUpdatedAt = Date.now() - 10_000;
        await writeSessionStoreSeed(store, {
          [scenario.storedSessionKey]: {
            sessionId,
            sessionFile,
            updatedAt: registryUpdatedAt,
            ...(scenario.status ? { status: scenario.status } : {}),
            sessionStartedAt: registryUpdatedAt - 60_000,
            lastInteractionAt: registryUpdatedAt - 30_000,
            startedAt: registryUpdatedAt - 1_000,
            endedAt: registryUpdatedAt - 100,
            cliSessionBindings: {
              "claude-cli": { sessionId: "old-claude-cli-session" },
              "codex-cli": { sessionId: "old-codex-cli-session" },
            },
            cliSessionIds: {
              "claude-cli": "old-claude-cli-session",
              "codex-cli": "old-codex-cli-session",
            },
            claudeCliSessionId: "old-claude-cli-session",
          },
        });
        await appendTranscriptEvent(
          {
            agentId: "main",
            sessionId,
            sessionKey: scenario.storedSessionKey,
            storePath: store,
          },
          { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
        );
        const cfg = mockConfig(home, store);
        cfg.session = { ...cfg.session, mainKey: scenario.mainKey };

        const resolution = await resolveSession({ cfg, sessionKey: scenario.requestedSessionKey });

        expect(resolution.sessionKey).toBe(scenario.storedSessionKey);
        expect(resolution.isNewSession).toBe(scenario.expectNewSession);
        if (!scenario.expectNewSession) {
          expect(resolution.sessionId).toBe(sessionId);
          expect(resolution.sessionEntry?.status).toBe(scenario.status);
          if (scenario.status === undefined) {
            expect(resolution.sessionEntry?.endedAt).toBe(registryUpdatedAt - 100);
          }
          return;
        }
        expect(resolution.sessionId).not.toBe(sessionId);
        expect(resolution.sessionEntry?.sessionFile).toBeUndefined();
        expect(resolution.sessionEntry?.status).toBeUndefined();
        expect(resolution.sessionEntry?.startedAt).toBeUndefined();
        expect(resolution.sessionEntry?.endedAt).toBeUndefined();
        expect(resolution.sessionEntry?.runtimeMs).toBeUndefined();
        expect(resolution.sessionEntry?.sessionStartedAt).toBeUndefined();
        expect(resolution.sessionEntry?.lastInteractionAt).toBeUndefined();
        expect(resolution.sessionEntry?.cliSessionBindings).toBeUndefined();
        expect(resolution.sessionEntry?.cliSessionIds).toBeUndefined();
        expect(resolution.sessionEntry?.claudeCliSessionId).toBeUndefined();
      });
    }
  });

  it("preserves explicit session-id resumes for stale terminal main rows", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionFile = path.join(home, "explicit-terminal-main.jsonl");
      const sessionId = "explicit-terminal-main";
      const registryUpdatedAt = Date.now() - 10_000;
      await writeSessionStoreSeed(store, {
        "agent:main:main": {
          sessionId,
          sessionFile,
          updatedAt: registryUpdatedAt,
          status: "done",
          startedAt: registryUpdatedAt - 1_000,
          endedAt: registryUpdatedAt - 100,
          runtimeMs: 900,
        },
      });
      await appendTranscriptEvent(
        {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:main",
          storePath: store,
        },
        { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
      );
      const cfg = mockConfig(home, store);

      const resolution = await resolveSession({ cfg, sessionId });

      expect(resolution.sessionKey).toBe("agent:main:main");
      expect(resolution.sessionId).toBe(sessionId);
      expect(resolution.isNewSession).toBe(false);
      expect(resolution.sessionEntry).not.toHaveProperty("sessionFile");
      expect(resolution.sessionEntry?.status).toBe("done");
      expect(resolution.sessionEntry?.startedAt).toBe(registryUpdatedAt - 1_000);
      expect(resolution.sessionEntry?.endedAt).toBe(registryUpdatedAt - 100);
      expect(resolution.sessionEntry?.runtimeMs).toBe(900);

      const persisted = loadSessionEntry({
        sessionKey: expectDefined(resolution.sessionKey, "resolved session key"),
        storePath: resolution.storePath,
      });
      expect(persisted?.sessionId).toBe(sessionId);
      expect(persisted).not.toHaveProperty("sessionFile");
      expect(persisted?.status).toBe("done");
      expect(persisted?.startedAt).toBe(registryUpdatedAt - 1_000);
      expect(persisted?.endedAt).toBe(registryUpdatedAt - 100);
      expect(persisted?.runtimeMs).toBe(900);
    });
  });
});
