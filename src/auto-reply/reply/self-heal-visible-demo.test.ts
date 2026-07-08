// Visible self-heal demonstration with step-by-step console output.
// Run with: pnpm test -- --reporter verbose
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing as sessionMcpTesting,
  getOrCreateSessionMcpRuntime,
} from "../../agents/agent-bundle-mcp-tools.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

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
      const callNum = (commitConflictControl.commitCalls.get(key) ?? 0) + 1;
      commitConflictControl.commitCalls.set(key, callNum);
      const remaining = commitConflictControl.forcedConflicts.get(key) ?? 0;
      if (remaining > 0) {
        commitConflictControl.forcedConflicts.set(key, remaining - 1);
        console.log(
          `    [commit #${callNum}] CAS REJECTED: revision mismatch (${remaining} forced conflicts remaining)`,
        );
        return {
          ok: false as const,
          reason: "stale-snapshot" as const,
          revision: "forced-conflict",
        };
      }
      console.log(`    [commit #${callNum}] CAS ACCEPTED: revision matches → store committed`);
      return await actual.commitReplySessionInitialization(params);
    },
  };
});

let suiteRoot = "";
let suiteCase = 0;

beforeEach(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "selfheal-demo-"));
  commitConflictControl.forcedConflicts.clear();
  commitConflictControl.commitCalls.clear();
  await sessionMcpTesting.resetSessionMcpRuntimeManager();
});

afterEach(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true }).catch(() => {});
});

describe("Self-Heal Demo: Conflict → Recovery → Delivery", () => {
  it("shows the full self-heal lifecycle", async () => {
    const dir = path.join(suiteRoot, `case${++suiteCase}`);
    await fs.mkdir(dir, { recursive: true });
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:dashboard:selfheal-demo";
    const wedgedSessionId = "wedged-demo-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: wedgedSessionId, updatedAt: Date.now() },
      }),
    );

    await getOrCreateSessionMcpRuntime({
      sessionId: wedgedSessionId,
      sessionKey,
      workspaceDir: path.dirname(storePath),
      cfg,
    });
    console.log(`\n  [setup] Wedged MCP runtime: ${wedgedSessionId}`);
    console.log(`  [setup] CAS forced conflicts: 4`);

    // Force 4 conflicts: main stale-retry + self-heal req + fenced reval 2
    commitConflictControl.forcedConflicts.set(sessionKey, 4);

    console.log(`\n  ═══ Message arrives: initSessionState() called ═══`);
    console.log(`  [step 1] Loading snapshot from store...`);

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "demo-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "dashboard",
        Surface: "dashboard",
      },
      cfg,
      commandAuthorized: true,
    });

    console.log(`\n  ═══ VERIFICATION ═══`);
    console.log(`  ✓ initSessionState COMPLETED (sessionId=${result.sessionId})`);
    console.log(
      `  ✓ Runtime disposed: ${!sessionMcpTesting.getCachedSessionIds().includes(wedgedSessionId)}`,
    );
    console.log(`  ✓ Total commit attempts: ${commitConflictControl.commitCalls.get(sessionKey)}`);
    console.log(`  ✓ Message DELIVERED successfully after self-heal recovery\n`);

    expect(result.sessionId).toBe(wedgedSessionId);
    expect(sessionMcpTesting.getCachedSessionIds()).not.toContain(wedgedSessionId);
    expect(commitConflictControl.commitCalls.get(sessionKey)).toBe(5);
  });
});
