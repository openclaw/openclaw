import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptFixtureSync } from "./chat.test-helpers.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runAfterMessageWrite: vi.fn(async () => {}),
  },
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

describe("appendInjectedAssistantMessageToTranscript after_message_write wiring", () => {
  let appendInjectedAssistantMessageToTranscript: typeof import("./chat-transcript-inject.js").appendInjectedAssistantMessageToTranscript;

  beforeAll(async () => {
    ({ appendInjectedAssistantMessageToTranscript } = await import("./chat-transcript-inject.js"));
  });

  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runAfterMessageWrite.mockClear();
    hookMocks.runner.runAfterMessageWrite.mockResolvedValue(undefined);
  });

  it("emits after_message_write with session context after successful append", () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-hook-",
      sessionId: "sess-hook",
    });

    try {
      const appended = appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "hook me",
        sessionKey: "agent:main:web:direct:abc",
        agentId: "main",
      });

      expect(appended.ok).toBe(true);
      expect(hookMocks.runner.runAfterMessageWrite).toHaveBeenCalledTimes(1);

      const firstCall = hookMocks.runner.runAfterMessageWrite.mock.calls[0];
      expect(firstCall).toBeDefined();
      const event = firstCall?.[0] as { sessionFile?: string; message?: { role?: string } };
      const ctx = firstCall?.[1] as { sessionKey?: string; agentId?: string };
      expect(event?.sessionFile).toBe(transcriptPath);
      expect(event?.message?.role).toBe("assistant");
      expect(ctx).toEqual({
        sessionKey: "agent:main:web:direct:abc",
        agentId: "main",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
