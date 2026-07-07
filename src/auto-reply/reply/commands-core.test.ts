// Tests core command dispatch, aliases, authorization, and handler outcomes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { HandleCommandsParams } from "./commands-types.js";

const readSessionMessagesAsyncMock = vi.hoisted(() => vi.fn());

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));

vi.mock("../../gateway/session-transcript-readers.js", () => ({
  readSessionMessagesAsync: readSessionMessagesAsyncMock,
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
        sessionFile: "/tmp/prev-session.jsonl",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    const [, ctx] = firstBeforeResetCall();
    return ctx;
  }

  beforeEach(() => {
    readSessionMessagesAsyncMock.mockReset();
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    readSessionMessagesAsyncMock.mockResolvedValue([]);
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

  it("uses the session transcript reader with reset-archive fallback", async () => {
    readSessionMessagesAsyncMock.mockResolvedValueOnce([
      { role: "user", content: "Recovered from archive" },
    ]);
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
        sessionFile: "/tmp/prev-session.jsonl",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    expect(readSessionMessagesAsyncMock).toHaveBeenCalledTimes(1);
    const [scope, opts] = readSessionMessagesAsyncMock.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(scope.sessionId).toBe("prev-session");
    expect(scope.sessionFile).toBe("/tmp/prev-session.jsonl");
    expect(scope.sessionKey).toBe("agent:main:telegram:group:-1003826723328:topic:8428");
    expect(opts.mode).toBe("full");
    expect(opts.allowResetArchiveFallback).toBe(true);
    const [event, ctx] = firstBeforeResetCall();
    expect(event.messages).toEqual([{ role: "user", content: "Recovered from archive" }]);
    expect(event.reason).toBe("new");
    expect(ctx.sessionId).toBe("prev-session");
  });

  it("passes through messages returned by the transcript reader", async () => {
    readSessionMessagesAsyncMock.mockResolvedValueOnce([
      { role: "user", content: "active root" },
      { role: "assistant", content: "active tail" },
    ]);

    await emitResetCommandHooks({
      action: "new",
      ctx: {} as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command: {
        surface: "discord",
        senderId: "rai",
        channel: "discord",
        from: "discord:rai",
        to: "discord:bot",
        resetHookTriggered: false,
      } as HandleCommandsParams["command"],
      sessionKey: "agent:main:main",
      previousSessionEntry: {
        sessionId: "prev-session",
        sessionFile: "/tmp/prev-session.jsonl",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    const [event] = firstBeforeResetCall();
    expect(event.messages).toEqual([
      { role: "user", content: "active root" },
      { role: "assistant", content: "active tail" },
    ]);
  });
});
