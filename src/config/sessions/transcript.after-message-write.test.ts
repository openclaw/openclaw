import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runAfterMessageWrite: vi.fn(async () => {}),
  },
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

describe("appendAssistantMessageToSessionTranscript after_message_write wiring", () => {
  let tempDir = "";
  let storePath = "";
  let appendAssistantMessageToSessionTranscript: typeof import("./transcript.js").appendAssistantMessageToSessionTranscript;

  beforeEach(async () => {
    ({ appendAssistantMessageToSessionTranscript } = await import("./transcript.js"));

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-hook-"));
    const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");

    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runAfterMessageWrite.mockClear();
    hookMocks.runner.runAfterMessageWrite.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits after_message_write after successful mirror append", async () => {
    const sessionKey = "agent:main:telegram:direct:u1";
    const store = {
      [sessionKey]: {
        sessionId: "sess-hook",
        chatType: "direct",
        channel: "telegram",
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "mirrored reply",
      storePath,
      agentId: "main",
    });

    expect(result.ok).toBe(true);
    expect(hookMocks.runner.runAfterMessageWrite).toHaveBeenCalledTimes(1);

    const mockCalls = hookMocks.runner.runAfterMessageWrite.mock.calls as unknown as Array<
      unknown[]
    >;
    const firstCall = mockCalls[0];
    expect(firstCall).toBeDefined();
    const event = firstCall?.[0] as { sessionFile?: string; message?: { role?: string } };
    const ctx = firstCall?.[1] as { sessionKey?: string; agentId?: string };
    expect(event?.sessionFile).toBe((result as { ok: true; sessionFile: string }).sessionFile);
    expect(event?.message?.role).toBe("assistant");
    expect(ctx).toEqual({ sessionKey, agentId: "main" });
  });
});
