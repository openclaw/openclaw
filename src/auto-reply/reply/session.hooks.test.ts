import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { saveSessionStore } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runSessionStart: vi.fn(async () => {}),
    runSessionEnd: vi.fn(async () => {}),
  },
}));

const countSessionMessages = vi.hoisted(() => vi.fn(async () => 2));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...mod,
    countSessionMessages: (...args: unknown[]) => countSessionMessages(...args),
  };
});

describe("initSessionState hooks", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hook: string) => hook === "session_start" || hook === "session_end",
    );
    hookMocks.runner.runSessionStart.mockReset().mockResolvedValue(undefined);
    hookMocks.runner.runSessionEnd.mockReset().mockResolvedValue(undefined);
    countSessionMessages.mockReset().mockResolvedValue(2);
  });

  it("emits session_end and session_start with resume info", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-hooks-"));
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:dm:123";
    const previousSessionId = "prev-session";
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: previousSessionId,
        sessionFile: path.join(root, "prev.jsonl"),
        updatedAt: Date.now(),
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/new",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    await vi.waitFor(() => expect(hookMocks.runner.runSessionEnd).toHaveBeenCalled());
    await vi.waitFor(() => expect(hookMocks.runner.runSessionStart).toHaveBeenCalled());

    expect(hookMocks.runner.runSessionEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: previousSessionId,
        messageCount: 2,
        sessionFile: path.join(root, "prev.jsonl"),
      }),
      { agentId: "main", sessionId: previousSessionId },
    );
    expect(hookMocks.runner.runSessionStart).toHaveBeenCalledWith(
      { sessionId: result.sessionEntry.sessionId, resumedFrom: previousSessionId },
      { agentId: "main", sessionId: result.sessionEntry.sessionId },
    );
  });
});
