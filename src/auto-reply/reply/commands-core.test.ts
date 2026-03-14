import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  unregisterInternalHook,
} from "../../hooks/internal-hooks.js";
import type { HookRunner } from "../../plugins/hooks.js";
import type { HandleCommandsParams } from "./commands-types.js";

const hookRunnerMocks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeReset: vi.fn<HookRunner["runBeforeReset"]>(),
}));
const routeReplyMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, messageId: "hook-reply" })),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: hookRunnerMocks.hasHooks,
      runBeforeReset: hookRunnerMocks.runBeforeReset,
    }) as unknown as HookRunner,
}));
vi.mock("./route-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./route-reply.js")>();
  return {
    ...actual,
    routeReply: routeReplyMocks.routeReply,
  };
});

const { emitResetCommandHooks } = await import("./commands-core.js");

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
    clearInternalHooks();
    hookRunnerMocks.hasHooks.mockReset();
    hookRunnerMocks.runBeforeReset.mockReset();
    hookRunnerMocks.hasHooks.mockImplementation((hookName) => hookName === "before_reset");
    hookRunnerMocks.runBeforeReset.mockResolvedValue(undefined);
    routeReplyMocks.routeReply.mockReset();
    routeReplyMocks.routeReply.mockResolvedValue({ ok: true, messageId: "hook-reply" });
  });

  afterEach(() => {
    clearInternalHooks();
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

  it("routes hook reply messages for reset/new command hooks", async () => {
    const handler = vi.fn((event) => {
      event.messages.push("Hook reply");
    });
    registerInternalHook("command:new", handler);

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
      ctx: {
        AccountId: "acc-1",
        MessageThreadId: "thread-1",
      } as HandleCommandsParams["ctx"],
      cfg: {} as HandleCommandsParams["cfg"],
      command,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(routeReplyMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "Hook reply" },
        channel: "discord",
        to: "discord:rai",
        sessionKey: "agent:main:main",
        accountId: "acc-1",
        threadId: "thread-1",
      }),
    );

    unregisterInternalHook("command:new", handler);
  });
});
