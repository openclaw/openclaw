import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import { saveSessionStore, updateSessionStore } from "./store.js";
import { resolveObservableSessionStatePathForStore } from "./observable-state.js";
import type { SessionEntry } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: overrides.sessionId ?? "sess-1",
    updatedAt: overrides.updatedAt ?? 100,
    model: overrides.model ?? "openai-codex/gpt-5.4",
    modelProvider: overrides.modelProvider ?? "openai-codex",
    channel: overrides.channel ?? "discord",
    ...overrides,
  };
}

describe("sessions observable state", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
  });

  it("writes per-agent session-state.json when saving the session store", async () => {
    await withStateDirEnv("openclaw-session-state-", async ({ stateDir }) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const storePath = resolveDefaultSessionStorePath();

      await saveSessionStore(storePath, {
        "agent:main:main": createSessionEntry({
          sessionId: "sess-main",
          updatedAt: 200,
          displayName: "Main session",
        }),
      });

      const observablePath = resolveObservableSessionStatePathForStore(storePath);
      expect(existsSync(observablePath)).toBe(true);

      const snapshot = JSON.parse(readFileSync(observablePath, "utf8")) as {
        agentId: string;
        total: number;
        sessions: Array<{ sessionKey: string; sessionId: string; displayName?: string; model?: string }>;
      };

      expect(snapshot.agentId).toBe("main");
      expect(snapshot.total).toBe(1);
      expect(snapshot.sessions[0]).toMatchObject({
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        displayName: "Main session",
        model: "openai-codex/gpt-5.4",
      });
    });
  });

  it("updates the per-agent session-state.json when the session store changes", async () => {
    await withStateDirEnv("openclaw-session-state-update-", async ({ stateDir }) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const storePath = resolveDefaultSessionStorePath();

      await saveSessionStore(storePath, {
        "agent:main:main": createSessionEntry({
          sessionId: "sess-main",
          updatedAt: 100,
          status: "running",
        }),
      });

      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = createSessionEntry({
          ...store["agent:main:main"],
          sessionId: "sess-main",
          updatedAt: 300,
          status: "done",
          runtimeMs: 1234,
        });
      });

      const snapshot = JSON.parse(
        readFileSync(resolveObservableSessionStatePathForStore(storePath), "utf8"),
      ) as {
        sessions: Array<{ sessionKey: string; status?: string; runtimeMs?: number; updatedAt: number }>;
      };

      expect(snapshot.sessions[0]).toMatchObject({
        sessionKey: "agent:main:main",
        status: "done",
        runtimeMs: 1234,
        updatedAt: 300,
      });
    });
  });

  it("keeps separate snapshots for different agents", async () => {
    await withStateDirEnv("openclaw-session-state-multi-agent-", async ({ stateDir }) => {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const mainStorePath = resolveDefaultSessionStorePath("main");
      const opsStorePath = resolveDefaultSessionStorePath("ops");

      await saveSessionStore(mainStorePath, {
        "agent:main:main": createSessionEntry({
          sessionId: "sess-main",
          updatedAt: 100,
          displayName: "Main session",
        }),
      });

      await saveSessionStore(opsStorePath, {
        "agent:ops:main": createSessionEntry({
          sessionId: "sess-ops",
          updatedAt: 200,
          displayName: "Ops session",
        }),
      });

      const mainSnapshot = JSON.parse(
        readFileSync(resolveObservableSessionStatePathForStore(mainStorePath), "utf8"),
      ) as { agentId: string; sessions: Array<{ sessionKey: string }> };
      const opsSnapshot = JSON.parse(
        readFileSync(resolveObservableSessionStatePathForStore(opsStorePath), "utf8"),
      ) as { agentId: string; sessions: Array<{ sessionKey: string }> };

      expect(mainSnapshot.agentId).toBe("main");
      expect(mainSnapshot.sessions).toMatchObject([{ sessionKey: "agent:main:main" }]);
      expect(opsSnapshot.agentId).toBe("ops");
      expect(opsSnapshot.sessions).toMatchObject([{ sessionKey: "agent:ops:main" }]);
    });
  });
});
