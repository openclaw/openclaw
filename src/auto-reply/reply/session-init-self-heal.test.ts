// Integration tests: verify the reply-session-init self-heal recovers from
// repeated CAS conflicts instead of permanently wedging the session (#102020).
//
// These tests force commitReplySessionInitialization to return ok:false a
// controlled number of times, then exercise the full initSessionState path
// through the store/writer/admission machinery to prove the self-heal
// disposes the wedged runtime and unwedges the session.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing as sessionMcpTesting,
  getOrCreateSessionMcpRuntime,
} from "../../agents/agent-bundle-mcp-tools.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

// Force commitReplySessionInitialization to conflict a set number of times
const commitConflictControl = vi.hoisted(() => ({
  forcedConflicts: new Map<string, number>(),
  commitCalls: new Map<string, number>(),
}));

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    commitReplySessionInitialization: async (
      params: Parameters<typeof actual.commitReplySessionInitialization>[0],
    ) => {
      const key = params.activeSessionKey ?? params.sessionKey;
      commitConflictControl.commitCalls.set(
        key,
        (commitConflictControl.commitCalls.get(key) ?? 0) + 1,
      );
      const remaining = commitConflictControl.forcedConflicts.get(key) ?? 0;
      if (remaining > 0) {
        commitConflictControl.forcedConflicts.set(key, remaining - 1);
        return {
          ok: false as const,
          reason: "stale-snapshot" as const,
          revision: "forced-conflict",
        };
      }
      return await actual.commitReplySessionInitialization(params);
    },
  };
});

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-102020-selfheal-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  commitConflictControl.forcedConflicts.clear();
  commitConflictControl.commitCalls.clear();
  await sessionMcpTesting.resetSessionMcpRuntimeManager();
});

afterEach(() => {
  commitConflictControl.forcedConflicts.clear();
  commitConflictControl.commitCalls.clear();
});

async function makeStorePath(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "sessions.json");
}

async function writeSessionStoreFast(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
}

describe("initSessionState self-heal recovery (#102020)", () => {
  it("unwedges the session via fenced self-heal when commit keeps conflicting", async () => {
    const storePath = await makeStorePath("selfheal-");
    const sessionKey = "agent:main:telegram:dm:selfheal-user";
    const wedgedSessionId = "wedged-session-id";
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: wedgedSessionId, updatedAt: Date.now() },
    });

    // Create a real MCP runtime — the self-heal must dispose this
    await getOrCreateSessionMcpRuntime({
      sessionId: wedgedSessionId,
      sessionKey,
      workspaceDir: path.dirname(storePath),
      cfg,
    });
    expect(sessionMcpTesting.getCachedSessionIds()).toContain(wedgedSessionId);

    // Force 4 conflicts:
    //   attempt #1: stale-snapshot-retry → conflicted (forced)
    //   attempt #2: self-heal-retry request → conflicted (forced)
    //                 → fenced revalidation
    //   attempt #3: stale-snapshot-retry → conflicted (forced)
    //   attempt #4: self-heal-retry request → conflicted (forced)
    //                 → drains, disposes runtime, resets harness
    //   attempt #5: post-teardown → SUCCESS (no more forced)
    commitConflictControl.forcedConflicts.set(sessionKey, 4);

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "selfheal-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    // Proof 1: init completed instead of throwing
    expect(result.sessionId).toBe(wedgedSessionId);

    // Proof 2: the wedged MCP runtime was disposed by self-heal
    expect(sessionMcpTesting.getCachedSessionIds()).not.toContain(wedgedSessionId);

    // Proof 3: commit accounting — 5 total attempts, all forced consumed
    const calls = commitConflictControl.commitCalls.get(sessionKey);
    expect(calls).toBe(5);
    expect(commitConflictControl.forcedConflicts.get(sessionKey)).toBe(0);
  });

  it("throws after self-heal budget is exhausted", async () => {
    const storePath = await makeStorePath("exhausted-");
    const sessionKey = "agent:main:telegram:dm:exhausted-user";
    const wedgedSessionId = "exhausted-session-id";
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: { sessionId: wedgedSessionId, updatedAt: Date.now() },
    });

    await getOrCreateSessionMcpRuntime({
      sessionId: wedgedSessionId,
      sessionKey,
      workspaceDir: path.dirname(storePath),
      cfg,
    });

    // 6 conflicts exceeds all recovery budgets
    commitConflictControl.forcedConflicts.set(sessionKey, 6);

    await expect(
      initSessionState({
        ctx: {
          Body: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "exhausted-user",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      }),
    ).rejects.toThrow(/reply session initialization conflicted.*after harness self-heal retry/);
  });
});
