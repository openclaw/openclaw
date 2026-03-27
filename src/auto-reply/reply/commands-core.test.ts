import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { HandleCommandsParams } from "./commands-types.js";

const internalHookMocks = vi.hoisted(() => ({
  triggerInternalHook: vi.fn(),
}));

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (
    _type: string,
    action: string,
    sessionKey: string,
    context: unknown,
  ) => ({
    type: "command",
    action,
    sessionKey,
    context,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    messages: [],
  }),
  triggerInternalHook: (...args: unknown[]) => internalHookMocks.triggerInternalHook(...args),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));

const { emitResetCommandHooks, resetRecentResetHookEmissionsForTest } =
  await import("./commands-core.js");

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

    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
    const [, ctx] = hookRunnerMocks.runBeforeReset.mock.calls[0] ?? [];
    return ctx;
  }

  beforeEach(() => {
    resetRecentResetHookEmissionsForTest();
    internalHookMocks.triggerInternalHook.mockReset();
    internalHookMocks.triggerInternalHook.mockResolvedValue(undefined);
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
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

  it("dedupes repeated reset-hook emission for the same prior session", async () => {
    const command = {
      surface: "discord",
      senderId: "rai",
      channel: "discord",
      from: "discord:rai",
      to: "discord:bot",
      resetHookTriggered: false,
    } as HandleCommandsParams["command"];

    const baseParams = {
      action: "new" as const,
      ctx: {} as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      sessionKey: "agent:main:discord:direct:123",
      previousSessionEntry: {
        sessionId: "prior-session-1",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    };

    await emitResetCommandHooks(baseParams);
    await emitResetCommandHooks({
      ...baseParams,
      command: { ...command, resetHookTriggered: false } as HandleCommandsParams["command"],
    });

    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(1));
  });

  it("allows reset-hook emission again when prior session changes", async () => {
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
      sessionKey: "agent:main:discord:direct:123",
      previousSessionEntry: {
        sessionId: "prior-session-1",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

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
      sessionKey: "agent:main:discord:direct:123",
      previousSessionEntry: {
        sessionId: "prior-session-2",
      } as HandleCommandsParams["previousSessionEntry"],
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(hookRunnerMocks.runBeforeReset).toHaveBeenCalledTimes(2));
  });
});
