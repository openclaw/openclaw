import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { HandleCommandsParams } from "./commands-types.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));

const sqliteTranscriptMocks = vi.hoisted(() => ({
  exportSqliteSessionTranscriptJsonl: vi.fn(() => ""),
  hasSqliteSessionTranscriptEvents: vi.fn(() => false),
}));

vi.mock("../../config/sessions/transcript-store.sqlite.js", () => ({
  exportSqliteSessionTranscriptJsonl: sqliteTranscriptMocks.exportSqliteSessionTranscriptJsonl,
  hasSqliteSessionTranscriptEvents: sqliteTranscriptMocks.hasSqliteSessionTranscriptEvents,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

const { emitResetCommandHooks } = await import("./commands-reset-hooks.js");

describe("emitResetCommandHooks", () => {
  async function runBeforeResetContext(sessionKey?: string) {
    const command = {
      surface: "discord",
      senderId: "rai",
      channel: "discord",
      from: "discord:rai",
      to: "discord:bot",
      resetHookTriggered: false,
    } as HandleCommandsParams["command"];

    await emitResetCommandHooks({
      action: "new",
      ctx: {} as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      sessionKey,
      previousSessionEntry: {
        sessionId: "prev-session",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1);
    const [, ctx] = hookRunnerMocks.runBeforeReset.mock.calls[0] ?? [];
    return ctx;
  }

  beforeEach(() => {
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    sqliteTranscriptMocks.exportSqliteSessionTranscriptJsonl.mockReturnValue("");
    sqliteTranscriptMocks.hasSqliteSessionTranscriptEvents.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the bound agent id to before_reset hooks for multi-agent session keys", async () => {
    const ctx = await runBeforeResetContext("agent:navi:main");
    expect(ctx).toMatchObject({
      agentId: "navi",
      sessionKey: "agent:navi:main",
      sessionId: "prev-session",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("falls back to main when the reset hook has no session key", async () => {
    const ctx = await runBeforeResetContext(undefined);
    expect(ctx).toMatchObject({
      agentId: "main",
      sessionKey: undefined,
      sessionId: "prev-session",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("keeps the main-agent path on the main agent workspace", async () => {
    const ctx = await runBeforeResetContext("agent:main:main");
    expect(ctx).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "prev-session",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("fires before_reset with empty messages when no scoped SQLite transcript exists", async () => {
    const command = {
      surface: "telegram",
      senderId: "vac",
      channel: "telegram",
      from: "telegram:vac",
      to: "telegram:bot",
      resetHookTriggered: false,
    } as HandleCommandsParams["command"];

    await emitResetCommandHooks({
      action: "new",
      ctx: {} as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      sessionKey: "agent:main:telegram:group:-1003826723328:topic:8428",
      previousSessionEntry: {
        sessionId: "prev-session",
        sessionFile: "sqlite-transcript://main/prev-session.jsonl",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "sqlite-transcript://main/prev-session.jsonl",
        messages: [],
        reason: "new",
      }),
      expect.objectContaining({
        sessionId: "prev-session",
      }),
    );
  });

  it("uses scoped SQLite transcript events for before_reset when JSONL is missing", async () => {
    sqliteTranscriptMocks.hasSqliteSessionTranscriptEvents.mockReturnValue(true);
    sqliteTranscriptMocks.exportSqliteSessionTranscriptJsonl.mockReturnValue(
      `${JSON.stringify({
        type: "session",
        id: "prev-session",
        timestamp: "2026-05-06T12:00:00.000Z",
      })}\n${JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "assistant", content: "Recovered from SQLite" },
      })}\n`,
    );
    const command = {
      surface: "discord",
      senderId: "vac",
      channel: "discord",
      from: "discord:vac",
      to: "discord:bot",
      resetHookTriggered: false,
    } as HandleCommandsParams["command"];

    await emitResetCommandHooks({
      action: "reset",
      ctx: {} as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      sessionKey: "agent:target:main",
      previousSessionEntry: {
        sessionId: "prev-session",
        sessionFile: "sqlite-transcript://main/prev-session.jsonl",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    expect(sqliteTranscriptMocks.hasSqliteSessionTranscriptEvents).toHaveBeenCalledWith({
      agentId: "target",
      sessionId: "prev-session",
    });
    expect(sqliteTranscriptMocks.exportSqliteSessionTranscriptJsonl).toHaveBeenCalledWith({
      agentId: "target",
      sessionId: "prev-session",
    });
    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "sqlite-transcript://main/prev-session.jsonl",
        messages: [{ role: "assistant", content: "Recovered from SQLite" }],
        reason: "reset",
      }),
      expect.objectContaining({
        agentId: "target",
        sessionId: "prev-session",
      }),
    );
  });
});
