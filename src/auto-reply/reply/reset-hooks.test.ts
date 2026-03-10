import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

const { emitBeforeResetPluginHook } = await import("./reset-hooks.js");

describe("emitBeforeResetPluginHook", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-before-reset-"));
    storePath = path.join(tempDir, "sessions.json");
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("re-resolves transcript paths within the session store directory", async () => {
    const transcriptPath = path.join(tempDir, "sess-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "hello" } })}\n`,
      "utf-8",
    );
    const resolvedTranscriptPath = await fs.realpath(transcriptPath).catch(() => transcriptPath);

    await emitBeforeResetPluginHook({
      sessionKey: "agent:main:main",
      previousSessionEntry: {
        sessionId: "sess-main",
        sessionFile: "../../etc/passwd",
      },
      workspaceDir: "/tmp/openclaw-workspace",
      reason: "new",
      storePath,
    });

    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: resolvedTranscriptPath,
        messages: [{ role: "user", content: "hello" }],
        reason: "new",
      }),
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
      }),
    );
  });

  it("caps extracted transcript messages to a bounded maximum", async () => {
    const transcriptPath = path.join(tempDir, "sess-cap.jsonl");
    const lines = Array.from({ length: 1_050 }, (_, index) =>
      JSON.stringify({ type: "message", message: { role: "user", content: `m-${index}` } }),
    ).join("\n");
    await fs.writeFile(transcriptPath, `${lines}\n`, "utf-8");

    await emitBeforeResetPluginHook({
      sessionKey: "agent:main:main",
      previousSessionEntry: {
        sessionId: "sess-cap",
        sessionFile: "sess-cap.jsonl",
      },
      workspaceDir: "/tmp/openclaw-workspace",
      reason: "reset",
      storePath,
    });

    const [event] = hookRunnerMocks.runBeforeReset.mock.calls[0] ?? [];
    const messages = event?.messages;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(1_000);
    expect(messages?.[0]).toEqual({ role: "user", content: "m-0" });
    expect(messages?.at(-1)).toEqual({ role: "user", content: "m-999" });
  });
});
