import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteSessionTranscriptEvent } from "../../config/sessions/transcript-store.sqlite.js";
import type { HookRunner } from "../../plugins/hooks.js";
import type { HandleCommandsParams } from "./commands-types.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));

const sqliteTranscriptMocks = vi.hoisted(() => ({
  hasSqliteSessionTranscriptEvents: vi.fn(() => false),
  loadSqliteSessionTranscriptEvents: vi.fn<() => SqliteSessionTranscriptEvent[]>(() => []),
}));
const legacySessionFileProperty = ["session", "File"].join("");

vi.mock("../../config/sessions/transcript-store.sqlite.js", () => ({
  hasSqliteSessionTranscriptEvents: sqliteTranscriptMocks.hasSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptEvents: sqliteTranscriptMocks.loadSqliteSessionTranscriptEvents,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

const { emitResetCommandHooks } = await import("./commands-reset-hooks.js");

function firstBeforeResetCall() {
  const call = hookRunnerMocks.runBeforeReset.mock.calls[0] as
    | [Record<string, unknown>, Record<string, unknown>]
    | undefined;
  if (!call) {
    throw new Error("expected before reset hook call");
  }
  return call;
}

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
    const [, ctx] = firstBeforeResetCall();
    return ctx;
  }

  beforeEach(() => {
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    sqliteTranscriptMocks.hasSqliteSessionTranscriptEvents.mockReturnValue(false);
    sqliteTranscriptMocks.loadSqliteSessionTranscriptEvents.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the bound agent id to before_reset hooks for multi-agent session keys", async () => {
    const ctx = await runBeforeResetContext("agent:navi:main");
    expect(ctx?.agentId).toBe("navi");
    expect(ctx?.sessionKey).toBe("agent:navi:main");
    expect(ctx?.sessionId).toBe("prev-session");
    expect(ctx?.workspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("falls back to main when the reset hook has no session key", async () => {
    const ctx = await runBeforeResetContext(undefined);
    expect(ctx?.agentId).toBe("main");
    expect(ctx?.sessionKey).toBeUndefined();
    expect(ctx?.sessionId).toBe("prev-session");
    expect(ctx?.workspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("keeps the main-agent path on the main agent workspace", async () => {
    const ctx = await runBeforeResetContext("agent:main:main");
    expect(ctx?.agentId).toBe("main");
    expect(ctx?.sessionKey).toBe("agent:main:main");
    expect(ctx?.sessionId).toBe("prev-session");
    expect(ctx?.workspaceDir).toBe("/tmp/openclaw-workspace");
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
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    const [event, ctx] = hookRunnerMocks.runBeforeReset.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).not.toHaveProperty(legacySessionFileProperty);
    expect(event.messages).toEqual([]);
    expect(event.reason).toBe("new");
    expect(ctx.sessionId).toBe("prev-session");
  });

  it("uses scoped SQLite transcript events for before_reset", async () => {
    sqliteTranscriptMocks.hasSqliteSessionTranscriptEvents.mockReturnValue(true);
    sqliteTranscriptMocks.loadSqliteSessionTranscriptEvents.mockReturnValue([
      {
        seq: 1,
        event: {
          type: "session",
          id: "prev-session",
          timestamp: "2026-05-06T12:00:00.000Z",
        },
        createdAt: Date.parse("2026-05-06T12:00:00.000Z"),
      },
      {
        seq: 2,
        event: {
          type: "message",
          id: "m1",
          message: { role: "assistant", content: "Recovered from SQLite" },
        },
        createdAt: Date.parse("2026-05-06T12:00:01.000Z"),
      },
    ]);
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
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    expect(sqliteTranscriptMocks.hasSqliteSessionTranscriptEvents).toHaveBeenCalledWith({
      agentId: "target",
      sessionId: "prev-session",
    });
    expect(sqliteTranscriptMocks.loadSqliteSessionTranscriptEvents).toHaveBeenCalledWith({
      agentId: "target",
      sessionId: "prev-session",
    });
    expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({
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
